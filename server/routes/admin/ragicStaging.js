/**
 * Task #66：Ragic 待審核區
 * - GET    /api/admin/ragic-staging?status=pending&form=&search=
 * - GET    /api/admin/ragic-staging/count           （sidebar badge 用）
 * - POST   /api/admin/ragic-staging/:id/approve
 * - POST   /api/admin/ragic-staging/:id/merge       ({ target_entity_id })
 *     P1.1「熊韋程 staff 事故」防線：staff「新增」提案若跟既有列撞號（phone/
 *     line_uid/姓名+場館），GET / 會在該筆附上 collision 欄位，approve 也會被
 *     擋下（STAFF_COLLISION_SUSPECTED）；只能改用這支把提案套用到既有列上。
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
    // A7（熊韋程卡 pending 調查）：先前這個 catch block 完全沒有 log，前端也只看得到
    // 一句通用錯誤訊息，管理員完全無從得知「為什麼卡住」。這裡補上伺服器端結構化
    // log（含完整 stack + 這筆是哪個 entity），並把實際失敗原因（Postgres 錯誤訊息 /
    // 明確描述，例如唯一鍵衝突）回傳給前端顯示在待審核介面——但不回傳完整 stack
    // trace 給 client，避免洩漏內部細節。
    console.error('[ragic-staging approve] failed to apply staged change', {
      staging_id: req.params.id,
      entity_type: err.stagingEntityType,
      entity_id: err.stagingEntityId,
      message: err.message,
      code: err.code,
      stack: err.stack,
    });
    res.status(400).json({
      error: err.message || '核准失敗，原因不明',
      entity_type: err.stagingEntityType,
      entity_id: err.stagingEntityId,
    });
  }
});

// P1.1「熊韋程 staff 事故」合併動作：admin 人工確認一筆 staff「新增」提案其實是
// 既有 target_entity_id 這個人（員工編號變更誤判成新人），把提案套用到既有列上，
// 而不是走一般 approve 建出第二筆。前端待審核頁應在 GET / 回傳的 collision 欄位
// 非空時，把「通過並套用」換成這個合併動作。
router.post('/:id/merge', async (req, res) => {
  const targetEntityId = String(req.body?.target_entity_id || '').trim();
  if (!targetEntityId) return res.status(400).json({ error: 'target_entity_id 必填' });
  try {
    const result = await ragicAdmin.mergeStagedStaffChange(req.params.id, targetEntityId, req.adminUser.sub);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ragic-staging merge] failed to merge staged change', {
      staging_id: req.params.id,
      target_entity_id: targetEntityId,
      entity_type: err.stagingEntityType,
      entity_id: err.stagingEntityId,
      message: err.message,
      stack: err.stack,
    });
    res.status(400).json({
      error: err.message || '合併失敗，原因不明',
      entity_type: err.stagingEntityType,
      entity_id: err.stagingEntityId,
    });
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
      // 同 /:id/approve：補結構化 log，方便事後從伺服器 log 追查批次核准中卡住的那幾筆。
      console.error('[ragic-staging bulk-approve] failed to apply staged change', {
        staging_id: id,
        entity_type: err.stagingEntityType,
        entity_id: err.stagingEntityId,
        message: err.message,
        stack: err.stack,
      });
      results.failed.push({ id, error: err.message, entity_type: err.stagingEntityType, entity_id: err.stagingEntityId });
    }
  }
  res.json(results);
});

module.exports = router;
