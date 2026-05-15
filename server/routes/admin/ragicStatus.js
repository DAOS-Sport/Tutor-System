/**
 * Ragic 連線健康檢查 (Task #65)
 *  GET  /api/admin/ragic-status            → enabled / env flags / 各 form 最近同步狀態
 *  POST /api/admin/ragic-status/sync       → 手動觸發同步（admin only）
 *    body: { job?: 'staff' | 'coaches' | 'venues' | 'all' }，預設 'all'
 *
 * 純讀部分（GET）admin/manager 都看得到，便於主管監控；手動觸發只有 admin 可按。
 */
const express = require('express');
const ragicAdmin = require('../../services/ragicAdmin');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();

router.get('/', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const env = ragicAdmin.getRagicEnvFlags();
    const enabled = ragicAdmin.ragicEnabled();
    const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
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

const JOB_RUNNERS = {
  staff:   ragicAdmin.syncStaffFromRagic,
  coaches: ragicAdmin.syncCoachesFromRagic,
  venues:  ragicAdmin.syncVenuesFromRagic,
};

router.post('/sync', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  if (!ragicAdmin.ragicEnabled()) {
    return res.status(400).json({ error: 'Ragic 未設定（缺 RAGIC_API_KEY / RAGIC_BASE_URL）' });
  }
  const job = (req.body && req.body.job) || 'all';
  const jobs = job === 'all' ? ['staff', 'coaches', 'venues'] : [job];
  for (const j of jobs) {
    if (!JOB_RUNNERS[j]) return res.status(400).json({ error: `未知 job：${j}` });
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
