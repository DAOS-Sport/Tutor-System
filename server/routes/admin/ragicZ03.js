/**
 * Z03 人工整理表 — 尚未綁定 LINE UID 的 Ragic Z01 家長/學員資料的審核佇列
 * - GET   /api/admin/ragic-z03/stats                  — 各狀態筆數統計
 * - GET   /api/admin/ragic-z03?status=pending|resolved|dismissed|all&q=電話或學生姓名
 * - PATCH /api/admin/ragic-z03/:id/draft ({ record, students }) — 儲存本地 Z03；完整時寫回 Ragic，LINE UID 由登入流程綁定
 * - PATCH /api/admin/ragic-z03/:id   ({ fixed_name }) — 寫回 Ragic Z01 姓名欄位並標記 resolved
 * - POST  /api/admin/ragic-z03/:id/dismiss           — 標記誤判，不寫 Ragic
 * - DELETE /api/admin/ragic-z03/:id?confirm=true      — 實體刪除 Z03 家長與學員，保留 tombstone 防止復活
 *
 * Z01 本地鏡像只收「必填齊全 ＋ LINE UID 已綁定」的完成記錄；
 * 其餘（缺 UID 或任一必填缺失）一律進此佇列。櫃台只整理核心資料；UID 由家長登入自動綁定。
 */
const express = require('express');
const { parsePaging } = require('../../utils/paging');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const ragicAdmin = require('../../services/ragicAdmin');
const { pool } = require('../../models/db');

const router = express.Router();

router.use(requireAdminAuth);
router.use(requireAdminRole('admin', 'manager', 'staff'));

router.get('/stats', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM ragic_z03_records GROUP BY status`
    );
    const stats = { pending: 0, resolved: 0, manual_review: 0, dismissed: 0, total: 0 };
    for (const row of r.rows) {
      if (stats[row.status] !== undefined) stats[row.status] = row.n;
      stats.total += row.n;
    }
    res.json(stats);
  } catch (err) {
    console.error('[admin/ragic-z03/stats]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const q = req.query.q || '';
    // 沒帶 limit 就照舊全撈（既有呼叫端行為不變）；前端一律會帶。
    const { limit, offset } = parsePaging(req);
    const items = await ragicAdmin.listZ03Records({ status, q, limit, offset });
    res.json({ items });
  } catch (err) {
    console.error('[admin/ragic-z03]', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/draft', async (req, res) => {
  try {
    const result = await ragicAdmin.saveZ03RecordDraft(req.params.id, req.body || {}, req.adminUser?.sub);
    res.json({ ok: true, saved: true, ...result });
  } catch (err) {
    console.error('[admin/ragic-z03/draft]', err);
    const status = err.code === 'STUDENT_ID_NUMBER_EXISTS' ? 409
      : err.code === 'RAGIC_TIMEOUT' ? 504
        : err.code ? 502 : 400;
    res.status(status).json({
      error: err.message || 'Z03 儲存失敗',
      code: err.code || 'Z03_DRAFT_SAVE_FAILED',
      saved: Boolean(err.z03Saved),
      item: err.z03Item || null,
    });
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

// Destructive local Z03 delete. Admin-only and requires explicit confirmation;
// the Ragic source record is not modified.
router.delete('/:id', requireAdminRole('admin'), async (req, res) => {
  try {
    if (String(req.query.confirm || '') !== 'true') {
      return res.status(400).json({
        error: '請帶 ?confirm=true 以確認刪除',
        code: 'CONFIRM_REQUIRED',
      });
    }
    const result = await ragicAdmin.deleteZ03Record(req.params.id, {
      adminUsername: req.adminUser?.sub,
      reason: req.body?.reason || null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin/ragic-z03] delete failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
