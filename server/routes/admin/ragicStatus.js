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

// 清除 Ragic 錯誤載入的 ghost 資料：
//   1. 硬刪 parents WHERE line_uid IS NULL（有業務 FK 者跳過）
//   2. 清空 ragic_z03_records
//   3. 清空 ragic_z01_quarantine
// 硬邊界：只動本地 DB，Ragic 端完全不碰。
//
// 修復（使用者回報：硬刪除幽靈家長後，下次 Z01 夜間同步又把他塞回 Z03/quarantine
// 「黑名單」）：Ragic 端這筆記錄本身沒有被刪除（本系統從不寫 Ragic H01/Z01），
// 硬刪除只是清掉本地鏡射；下次同步重新讀到同一筆 Ragic 原始資料，若姓名/UID/電話
// 仍不滿足「三必備條件」，_reconcileZ01FromShadowImpl 會無條件把他寫回 Z03，
// _quarantineBadZ01NamesImpl 也會無條件把他寫回 quarantine——因為兩者都沒有查過
// 「這個人是否已被 admin 決定永久排除」。改為：硬刪除當下順便把該筆的
// z01_ragic_record_id 寫進既有的 ragic_z03_deleted_tombstones（本來就是為了
// 「後台強制刪除後不要復活」設計的表，語意完全通用，不需要新建表），
// _upsertZ03Record／_quarantineBadZ01NamesImpl 之後都會查這張表並跳過。
// 只在「Ragic 端這筆仍未滿足畢業條件」時才會被排除；若這個人之後自己重新走
// LIFF 登入/綁定流程（走即時查詢 Ragic，不受此 tombstone 影響）而真正畢業，
// 夜間同步仍會正常同步他的最新資料，不會被永久卡住。
router.post('/purge-ghosts', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const { pool } = require('../../models/db');
  const parentSync = require('../../services/parentSync');
  if (!(await ragicAdmin.hasRecentFreshPull?.().catch(() => false))) {
    return res.status(409).json({
      error: '缺少最近一次 freshness_verified=true 的 Z01 pull，已拒絕清除 ghost，避免依過期 shadow/狀態刪資料。',
    });
  }
  const client = await pool.connect();
  try {
    // 1. 找出所有無 LINE UID 的 parents
    const noUid = await client.query(
      `SELECT id, ragic_record_id FROM parents WHERE line_uid IS NULL OR line_uid = ''`
    );
    let deletedParents = 0;
    let skippedParents = 0;
    let tombstoned = 0;
    for (const row of noUid.rows) {
      const deleted = await parentSync.hardDeleteParentIfSafe(client, row.id);
      if (!deleted) { skippedParents++; continue; }
      deletedParents++;
      if (row.ragic_record_id) {
        await client.query(
          `INSERT INTO ragic_z03_deleted_tombstones (z01_ragic_record_id, deleted_by, reason)
           VALUES ($1, $2, $3)
           ON CONFLICT (z01_ragic_record_id) DO NOTHING`,
          [String(row.ragic_record_id), req.adminUser?.sub || null, 'purge-ghosts：手動清除無 LINE UID 的幽靈家長']
        );
        tombstoned++;
      }
    }

    // 2. 清空 Z03 佇列
    const z03 = await client.query(`DELETE FROM ragic_z03_records RETURNING 1`);
    const deletedZ03 = z03.rowCount;

    // 3. 清空 quarantine（佔位名單）
    const q = await client.query(`DELETE FROM ragic_z01_quarantine RETURNING 1`);
    const deletedQuarantine = q.rowCount;

    console.log(`[purge-ghosts] parents 刪除=${deletedParents} 保留=${skippedParents}（有業務FK）; tombstoned=${tombstoned}; z03=${deletedZ03}; quarantine=${deletedQuarantine}`);
    res.json({
      ok: true,
      deleted_parents: deletedParents,
      skipped_parents: skippedParents,
      tombstoned,
      deleted_z03: deletedZ03,
      deleted_quarantine: deletedQuarantine,
      message: `已清除：${deletedParents} 筆 ghost 家長（其中 ${tombstoned} 筆已標記永久排除，未來同步不會再進 Z03/quarantine）、${deletedZ03} 筆 Z03、${deletedQuarantine} 筆 quarantine。${skippedParents ? `（${skippedParents} 筆有業務紀錄保留）` : ''}`,
    });
  } catch (err) {
    console.error('[purge-ghosts]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
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
