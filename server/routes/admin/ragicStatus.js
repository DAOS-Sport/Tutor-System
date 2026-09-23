/**
 * Ragic 連線健康檢查 (Task #65) — admin only
 *
 *  GET  /api/admin/ragic-status
 *    → { enabled, env, missing_env, schedules{ jobs, background }, forms{...}, now }
 *    schedules 來自 constants/ragicJobSchedules.js（與 cron/index.js 由測試比對）。
 *    `enabled` 為「6 個 RAGIC_* env 全到位」才為 true（光有 API_KEY+BASE_URL 不算齊全）
 *    forms[job].admin_enabled 是 admin 手動開關（見下方 /toggle），與上面全域 env `enabled` 是兩件事：
 *    env 沒設定 = 系統整體連不上 Ragic；admin_enabled=false = 這個 job 被人工暫停，其餘 job 不受影響。
 *
 *  POST /api/admin/ragic-status/sync?form=staff|venues|parents|students|backup|pull|all
 *    立即觸發同步 / ping，回傳每個 job 的結果與最新 forms 狀態。
 *    （也支援 body { form } 作為向後相容入口）。若該 job 被 /toggle 關閉，仍會回 202，
 *    但背景執行會被 services/ragicAdmin.js `_runWithLog` 擋下（status=skipped, disabled=true）。
 *
 *  POST /api/admin/ragic-status/toggle { job, enabled }
 *    手動開/關單一 job（存 admin_settings，見 ragicAdmin.setJobEnabled）。
 *    關閉後：cron 排程 + 這裡的 /sync 手動觸發都會被擋下，直到重新開啟。
 *
 * 同步覆蓋：
 *   staff / venues     — 真實 bulk sync（H01/H05）
 *   parents / students — 對 Z01/Z02 發一次 where=eq 健康檢查 ping
 *   backup             — 本地 parents/students → Ragic Z01/Z02（補寫回缺口）
 *   pull               — Ragic Z01/Z02 → 本地 parents/students 全量同步（補讀回缺口）
 *   各自的排程時間見 constants/ragicJobSchedules.js。
 */
const express = require('express');
const ragicAdmin = require('../../services/ragicAdmin');
const { RAGIC_JOB_SCHEDULES, RAGIC_BACKGROUND_SCHEDULES } = require('../../constants/ragicJobSchedules');
const { requireAdminAuth } = require('../../middlewares/adminAuth');
// F-A06：權限改由「角色權限管理」的設定決定。
const { requireResource } = require('../../middlewares/requireResource');

const router = express.Router();

// Task #91：coaches 同步已合併進 staff（H01 員工 API）；不再對外暴露 coaches 子任務
const JOB_RUNNERS = {
  staff:    ragicAdmin.syncStaffFromRagic,
  venues:   ragicAdmin.syncVenuesFromRagic,
  parents:  ragicAdmin.pingParentsFromRagic,
  students: ragicAdmin.pingStudentsFromRagic,
  backup:   ragicAdmin.backupParentsStudentsToRagic,
  pull:     ragicAdmin.pullParentsStudentsFromRagic,
  // quarantine（Z01 姓名品質掃描）2026-09-23 退役：不再顯示、不能手動觸發，見 ragicAdmin.RETIRED_JOBS
};
const ALL_JOBS = Object.keys(JOB_RUNNERS);

// 狀態頁只列還在用的工作（getSyncStatusSnapshot 依 FORM_META 列出全部，含已退役的）
async function activeJobSnapshot() {
  const forms = await ragicAdmin.getSyncStatusSnapshot();
  for (const job of Object.keys(forms)) {
    if (!JOB_RUNNERS[job]) delete forms[job];
  }
  return forms;
}

router.get('/', requireAdminAuth, requireResource('ragic-status'), async (req, res) => {
  try {
    const env = ragicAdmin.getRagicEnvFlags();
    const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
    const enabled = missing.length === 0;
    const forms = await activeJobSnapshot();
    const liveProbe = await ragicAdmin.getLiveRagicProbeSnapshot().catch((err) => ({
      ok: false,
      checked_at: new Date().toISOString(),
      error: err.message || String(err),
      forms: {},
    }));
    res.json({
      enabled,
      env,
      missing_env: missing,
      live_probe: liveProbe,
      // 以前回傳寫死的「每 10 分鐘」排程字串，但系統從來沒有每 10 分鐘的 Ragic 排程。
      schedules: { jobs: RAGIC_JOB_SCHEDULES, background: RAGIC_BACKGROUND_SCHEDULES },
      forms,
      now: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin/ragic-status]', err);
    res.status(500).json({ error: 'load ragic status failed' });
  }
});

// ── GET /api/admin/ragic-status/sync-failures ────────────────────────────────
// Phase 1 可觀測性（migration 040）：逐筆同步失敗一覽。
//   背景：ragic_sync_log 只保存 errors[0]，「144 筆失敗」在 DB 裡只剩第 1 筆訊息，
//   其餘原因原本只在 Replit console，事後無法還原、無法統計。
//   本端點純唯讀 SELECT，不觸發任何同步，不改任何狀態。
//   message 在寫入時已去識別化（syncFailureLog.sanitizeMessage），不含個資。
router.get('/sync-failures', requireAdminAuth, requireResource('ragic-status'), async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  try {
    const { pool } = require('../../models/db');
    const since = `${days} days`;
    const [summary, byCode, recent] = await Promise.all([
      pool.query(
        `SELECT error_kind, entity_kind, count(*)::int AS n,
                count(DISTINCT local_id)::int AS distinct_records,
                max(occurred_at) AS latest
           FROM ragic_sync_failures
          WHERE occurred_at >= NOW() - $1::interval
          GROUP BY 1,2 ORDER BY 3 DESC`, [since]),
      pool.query(
        `SELECT COALESCE(error_code,'(null)') AS error_code, count(*)::int AS n,
                count(DISTINCT local_id)::int AS distinct_records
           FROM ragic_sync_failures
          WHERE occurred_at >= NOW() - $1::interval
          GROUP BY 1 ORDER BY 2 DESC`, [since]),
      pool.query(
        `SELECT occurred_at, job_name, entity_kind, local_id, error_code, error_kind, message
           FROM ragic_sync_failures
          WHERE occurred_at >= NOW() - $1::interval
          ORDER BY occurred_at DESC LIMIT $2`, [since, limit]),
    ]);
    // 狀態頁用：每個 job 各有幾筆資料、因為什麼原因寫不過去（permanent＝資料本身要修，重試沒用）
    const byJobCode = await pool.query(
      `SELECT job_name, COALESCE(error_code,'(null)') AS error_code, error_kind,
              count(DISTINCT local_id)::int AS distinct_records
         FROM ragic_sync_failures
        WHERE occurred_at >= NOW() - $1::interval
        GROUP BY 1,2,3 ORDER BY 4 DESC`, [since]);
    // 反覆失敗的同一筆資料 = Phase 2 隔離（quarantine）的候選
    const repeat = await pool.query(
      `SELECT local_id, entity_kind, count(*)::int AS failures,
              min(occurred_at) AS first_seen, max(occurred_at) AS last_seen
         FROM ragic_sync_failures
        WHERE occurred_at >= NOW() - $1::interval AND error_kind = 'permanent'
        GROUP BY 1,2 HAVING count(*) >= 2
        ORDER BY 3 DESC LIMIT 100`, [since]);
    res.json({
      window_days: days,
      summary: summary.rows,
      by_error_code: byCode.rows,
      by_job_code: byJobCode.rows,
      repeat_permanent_failures: repeat.rows,
      recent: recent.rows,
      note: 'message 已去識別化；permanent 表示資料本身不合法，重試永遠失敗。',
    });
  } catch (err) {
    console.error('[admin/ragic-status sync-failures]', err.message);
    res.status(500).json({ error: '讀取同步失敗紀錄失敗' });
  }
});

router.get('/webhook-inbox', requireAdminAuth, requireResource('ragic-status'), async (req, res) => {
  try {
    const { pool } = require('../../models/db');
    const summary = await pool.query(`SELECT state,COUNT(*)::int AS count FROM ragic_webhook_inbox GROUP BY state`);
    const pending = await pool.query(`SELECT sheet_code,ragic_record_id,state,attempts,max_attempts,last_error_code,next_retry_at,updated_at
      FROM ragic_webhook_inbox WHERE state <> 'completed' ORDER BY updated_at DESC LIMIT 100`);
    res.json({ summary: summary.rows, items: pending.rows });
  } catch (err) { res.status(500).json({ error: 'WEBHOOK_INBOX_UNAVAILABLE' }); }
});

// Ragic 打進來的每一次請求（含被拒的，見 services/ragicWebhookAttempts.js）。唯讀。
router.get('/webhook-attempts', requireAdminAuth, requireResource('ragic-status'), async (req, res) => {
  try {
    const { pool } = require('../../models/db');
    const recent = await pool.query(
      `SELECT received_at, method, sheet_code, status, outcome, content_type, body_kind, id_count
         FROM ragic_webhook_attempts ORDER BY received_at DESC LIMIT 10`);
    const summary = await pool.query(
      `SELECT outcome, count(*)::int AS count, max(received_at) AS latest
         FROM ragic_webhook_attempts WHERE received_at >= NOW() - INTERVAL '7 days' GROUP BY 1`);
    res.json({ recent: recent.rows, summary: summary.rows });
  } catch (err) {
    res.status(500).json({ error: 'WEBHOOK_ATTEMPTS_UNAVAILABLE' });
  }
});

router.post('/webhook-inbox/retry', requireAdminAuth, requireResource('ragic-status'), async (req, res) => {
  const code = String(req.body?.sheet_code || '').toUpperCase();
  const id = String(req.body?.ragic_record_id ?? '');
  if (!['H01','H05','Z01','Z02'].includes(code) || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'INVALID_WEBHOOK_SELECTOR' });
  }
  try {
    const { pool } = require('../../models/db');
    const r = await pool.query(`UPDATE ragic_webhook_inbox SET state='pending',attempts=0,
      next_retry_at=NOW(),revision=revision+1,updated_at=NOW()
      WHERE sheet_code=$1 AND ragic_record_id=$2 AND state IN ('retryable','blocked') RETURNING ragic_record_id`, [code,id]);
    if (!r.rowCount) return res.status(409).json({ error: 'WEBHOOK_NOT_RETRYABLE' });
    res.status(202).json({ ok: true, state: 'pending' });
  } catch (err) { res.status(500).json({ error: 'WEBHOOK_RETRY_FAILED' }); }
});

router.post('/sync', requireAdminAuth, requireResource('ragic-status'), async (req, res) => {
  // 用與 GET 相同的判定（必須 6 個 RAGIC_* env 全到位）作為單一真相來源
  const env = ragicAdmin.getRagicEnvFlags();
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    return res.status(400).json({ error: 'Ragic 未完整設定', missing_env: missing });
  }
  const form = String(req.query.form || (req.body && req.body.form) || (req.body && req.body.job) || 'all');
  const jobs = form === 'all' ? ALL_JOBS : [form];
  for (const j of jobs) {
    if (!JOB_RUNNERS[j]) {
      return res.status(400).json({ error: `未知 form：${j}（可用：${ALL_JOBS.join('|')}|all）` });
    }
  }
  // Task #83：fire-and-forget — 立刻回 202，背景跑同步並寫入 ragic_sync_log。
  // 前端改用 5 秒 polling /api/admin/ragic-status 看 forms[].in_progress + last_*
  // 推導 UI 狀態（spinner / 完成 / 錯誤），不再阻塞 HTTP request。
  // single-flight mutex（services/ragicAdmin.js _singleflight）會自動把
  // 重複觸發合併成同一個 Promise，避免 cron + 手動雙擊打爆 Ragic。
  // form=all 不能同時把所有全表 job 丟出去：backup / pull 有業務順序，
  // 並行會讓 Ragic 同時處理多個大查詢/寫入，現場看起來就是「同步很久」。
  // 單一 job 仍照原行為背景執行；全部同步改在同一背景工作中依 ALL_JOBS 順序跑。
  const alreadyRunningJobs = jobs.filter((j) => ragicAdmin.isJobRunning(j));
  setImmediate(async () => {
    for (const j of jobs) {
      const runner = JOB_RUNNERS[j];
      try {
        await runner('manual');
      } catch (err) {
        console.warn(`[ragic-status/sync] ${j} background failed:`, err.message);
      }
    }
  });
  res.status(202).json({
    ok: true,
    accepted: true,
    queued_jobs: jobs,
    already_running_jobs: alreadyRunningJobs,
    message: alreadyRunningJobs.length
      ? `已排入背景同步，其中 ${alreadyRunningJobs.join('、')} 目前已在執行中，本次觸發會併入該次結果。`
      : '已排入背景同步，請稍候自動更新狀態。',
  });
});

// Compatibility endpoint retained so older admin builds fail closed. Source
// records, claims, parents and students are never deleted by reconciliation.
router.post('/purge-ghosts', requireAdminAuth, requireResource('ragic-status'), (req, res) => {
  res.status(410).json({
    error: '破壞性 reconcile 已停用；Ragic blank-UID source 必須保留在 Z03 resolved/pending/manual-review 之一。',
    code: 'DESTRUCTIVE_RECONCILE_DISABLED',
  });
});

router.post('/toggle', requireAdminAuth, requireResource('ragic-status'), async (req, res) => {
  const job = String(req.body?.job || '');
  const enabled = !!req.body?.enabled;
  if (!ALL_JOBS.includes(job)) {
    return res.status(400).json({ error: `未知 form：${job}（可用：${ALL_JOBS.join('|')}）` });
  }
  try {
    await ragicAdmin.setJobEnabled(job, enabled);
    const forms = await activeJobSnapshot();
    res.json({ ok: true, job, enabled, forms });
  } catch (err) {
    console.error('[admin/ragic-status toggle]', err);
    res.status(500).json({ error: 'update toggle failed' });
  }
});

module.exports = router;
