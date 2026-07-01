/**
 * Z03 人工整理表 — Ragic Z01 舊系統壞姓名（佔位電話號碼）家長/學員資料的審核佇列
 * - GET   /api/admin/ragic-z03?status=pending|resolved|dismissed|all
 * - PATCH /api/admin/ragic-z03/:id   ({ fixed_name }) — 寫回 Ragic Z01 姓名欄位並標記 resolved
 * - POST  /api/admin/ragic-z03/:id/dismiss           — 標記誤判，不寫 Ragic
 *
 * 資料本身由 server/services/ragicAdmin.js 的 01:00 pull job（_pullParentsStudentsImpl）
 * 灌入，這裡只負責讀取與人工動作。角色比照客戶資料管理（admin/manager/staff 皆可）——
 * 櫃台第一線最常直接知道客戶正確姓名，不比照 ragic-staging 的 admin-only（那是 HR 資料治理）。
 */
const express = require('express');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const ragicAdmin = require('../../services/ragicAdmin');

const router = express.Router();

router.use(requireAdminAuth);
router.use(requireAdminRole('admin', 'manager', 'staff'));

router.get('/', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const items = await ragicAdmin.listZ03Records({ status });
    res.json({ items });
  } catch (err) {
    console.error('[admin/ragic-z03]', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const updated = await ragicAdmin.resolveZ03Record(req.params.id, req.body?.fixed_name, req.adminUser?.sub);
    res.json({ ok: true, item: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/dismiss', async (req, res) => {
  try {
    const updated = await ragicAdmin.dismissZ03Record(req.params.id, req.adminUser?.sub);
    res.json({ ok: true, item: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
