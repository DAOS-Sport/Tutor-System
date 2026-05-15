/**
 * Task #66：Ragic 待審核區
 * - GET    /api/admin/ragic-staging?status=pending&form=&search=
 * - GET    /api/admin/ragic-staging/count           （sidebar badge 用）
 * - POST   /api/admin/ragic-staging/:id/approve
 * - POST   /api/admin/ragic-staging/:id/reject      ({ reason })
 * - POST   /api/admin/ragic-staging/bulk-approve    ({ ids: [...] })
 *
 * 全部要求 admin 角色。staff/manager 不應審核外部資料來源。
 */
const express = require('express');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const ragicAdmin = require('../../services/ragicAdmin');

const router = express.Router();

router.use(requireAdminAuth);
router.use(requireAdminRole('admin')); // 待審核屬外部資料治理，僅 admin 可見

router.get('/count', async (req, res) => {
  try {
    const pending = await ragicAdmin.countStagingPending();
    res.json({ pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { status, form, search } = req.query;
    const rows = await ragicAdmin.listStagingChanges({ status, form, search });
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const row = await ragicAdmin.applyStagedChange(req.params.id, req.adminUser.sub);
    res.json({ ok: true, applied: { entity_type: row.entity_type, entity_id: row.entity_id, change_type: row.change_type } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: '需提供退回原因' });
    await ragicAdmin.rejectStagedChange(req.params.id, req.adminUser.sub, reason);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/bulk-approve', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'ids 不能為空' });
  const results = { approved: [], failed: [] };
  for (const id of ids) {
    try {
      await ragicAdmin.applyStagedChange(id, req.adminUser.sub);
      results.approved.push(id);
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }
  res.json(results);
});

module.exports = router;
