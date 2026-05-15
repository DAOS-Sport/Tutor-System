/**
 * Ragic 連線健康檢查 (Task #65) — admin only
 *
 *  GET  /api/admin/ragic-status
 *    → { enabled, env, missing_env, cron_schedule, forms{...}, now }
 *    `enabled` 為「6 個 RAGIC_* env 全到位」才為 true（光有 API_KEY+BASE_URL 不算齊全）
 *
 *  POST /api/admin/ragic-status/sync?form=staff|coaches|venues|parents|students|all
 *    立即觸發同步 / ping，回傳每個 job 的結果與最新 forms 狀態。
 *    （也支援 body { form } 作為向後相容入口）
 *
 * 同步覆蓋：
 *   staff / coaches / venues — 真實 bulk sync（H01/H05）
 *   parents / students       — 對 Z01/Z02 發一次 where=eq 健康檢查 ping
 */
const express = require('express');
const ragicAdmin = require('../../services/ragicAdmin');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();

const JOB_RUNNERS = {
  staff:    ragicAdmin.syncStaffFromRagic,
  coaches:  ragicAdmin.syncCoachesFromRagic,
  venues:   ragicAdmin.syncVenuesFromRagic,
  parents:  ragicAdmin.pingParentsFromRagic,
  students: ragicAdmin.pingStudentsFromRagic,
};
const ALL_JOBS = Object.keys(JOB_RUNNERS);

router.get('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const env = ragicAdmin.getRagicEnvFlags();
    const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
    const enabled = missing.length === 0;
    const forms = await ragicAdmin.getSyncStatusSnapshot();
    res.json({
      enabled,
      env,
      missing_env: missing,
      cron_schedule: '*/10 * * * *',
      forms,
      now: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin/ragic-status]', err);
    res.status(500).json({ error: 'load ragic status failed' });
  }
});

router.post('/sync', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  if (!ragicAdmin.ragicEnabled()) {
    return res.status(400).json({ error: 'Ragic 未設定（缺 RAGIC_API_KEY / RAGIC_BASE_URL）' });
  }
  const form = String(req.query.form || (req.body && req.body.form) || (req.body && req.body.job) || 'all');
  const jobs = form === 'all' ? ALL_JOBS : [form];
  for (const j of jobs) {
    if (!JOB_RUNNERS[j]) {
      return res.status(400).json({ error: `未知 form：${j}（可用：${ALL_JOBS.join('|')}|all）` });
    }
  }
  const results = {};
  for (const j of jobs) {
    try {
      results[j] = await JOB_RUNNERS[j]('manual');
    } catch (err) {
      results[j] = { synced: 0, error: err.message };
    }
  }
  const forms = await ragicAdmin.getSyncStatusSnapshot();
  res.json({ ok: true, results, forms });
});

module.exports = router;
