/**
 * Ragic 連線健康檢查 (Task #65) — admin only
 *
 *  GET  /api/admin/ragic-status
 *    → { enabled, env, missing_env, cron_schedule, forms{...}, now }
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
 *   backup             — 本地 parents/students → Ragic Z01/Z02（補寫回缺口；cron 02:00）
 *   pull               — Ragic Z01/Z02 → 本地 parents/students 全量同步（補讀回缺口；cron 01:00）
 */
const express = require('express');
const ragicAdmin = require('../../services/ragicAdmin');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();

// Task #91：coaches 同步已合併進 staff（H01 員工 API）；不再對外暴露 coaches 子任務
const JOB_RUNNERS = {
  staff:    ragicAdmin.syncStaffFromRagic,
  venues:   ragicAdmin.syncVenuesFromRagic,
  parents:  ragicAdmin.pingParentsFromRagic,
  students: ragicAdmin.pingStudentsFromRagic,
  backup:   ragicAdmin.backupParentsStudentsToRagic,
  pull:     ragicAdmin.pullParentsStudentsFromRagic,
  quarantine: ragicAdmin.quarantineBadZ01Names,
};
const ALL_JOBS = Object.keys(JOB_RUNNERS);

function nextCronRunAt(now = new Date()) {
  // schedule = '*/10 * * * *' → 下一個 :00 :10 :20 :30 :40 :50
  const next = new Date(now.getTime());
  next.setSeconds(0, 0);
  const m = next.getMinutes();
  const add = 10 - (m % 10);
  next.setMinutes(m + add);
  return next.toISOString();
}

router.get('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const env = ragicAdmin.getRagicEnvFlags();
    const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
    const enabled = missing.length === 0;
    const forms = await ragicAdmin.getSyncStatusSnapshot();
    const liveProbe = await ragicAdmin.getLiveRagicProbeSnapshot().catch((err) => ({
      ok: false,
      checked_at: new Date().toISOString(),
      error: err.message || String(err),
      forms: {},
    }));
    const now = new Date();
    res.json({
      enabled,
      env,
      missing_env: missing,
      live_probe: liveProbe,
      cron_schedule: '*/10 * * * *',
      next_cron_run_at: nextCronRunAt(now),
      forms,
      now: now.toISOString(),
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
router.get('/sync-failures', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
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
      repeat_permanent_failures: repeat.rows,
      recent: recent.rows,
      note: 'message 已去識別化；permanent 表示資料本身不合法，重試永遠失敗。',
    });
  } catch (err) {
    console.error('[admin/ragic-status sync-failures]', err.message);
    res.status(500).json({ error: '讀取同步失敗紀錄失敗' });
  }
});

router.post('/sync', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
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
  // form=all 不能同時把所有全表 job 丟出去：backup / pull / quarantine 有業務順序，
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
router.post('/purge-ghosts', requireAdminAuth, requireAdminRole('admin'), (req, res) => {
  res.status(410).json({
    error: '破壞性 reconcile 已停用；Ragic blank-UID source 必須保留在 Z03 resolved/pending/manual-review 之一。',
    code: 'DESTRUCTIVE_RECONCILE_DISABLED',
  });
});

router.post('/toggle', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const job = String(req.body?.job || '');
  const enabled = !!req.body?.enabled;
  if (!ALL_JOBS.includes(job)) {
    return res.status(400).json({ error: `未知 form：${job}（可用：${ALL_JOBS.join('|')}）` });
  }
  try {
    await ragicAdmin.setJobEnabled(job, enabled);
    const forms = await ragicAdmin.getSyncStatusSnapshot();
    res.json({ ok: true, job, enabled, forms });
  } catch (err) {
    console.error('[admin/ragic-status toggle]', err);
    res.status(500).json({ error: 'update toggle failed' });
  }
});

module.exports = router;
