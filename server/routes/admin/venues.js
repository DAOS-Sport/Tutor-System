/**
 * 場館設定 (F-A03)
 *  GET    /api/admin/venues       → 全部場館（先 sync Ragic H05；best-effort）
 *  PATCH  /api/admin/venues/:id   → 更新場館資訊
 *
 * mock.js shape：
 *   { id, code, name, address, line_token,
 *     bank_institution_name, bank_branch_name, account_holder, account_number }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const { syncVenuesFromRagic, kickoffSyncVenuesAsync } = require('../../services/ragicAdmin');

const router = express.Router();

function rowToVenueFull(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    address: r.address || '',
    line_token: r.line_token || '',
    bank_institution_name: r.bank_institution_name || '',
    bank_branch_name: r.bank_branch_name || '',
    account_holder: r.account_holder || '',
    account_number: r.account_number || '',
  };
}

// 非 admin 角色只能看到顯示名稱用的安全欄位（給 venueMap[id]→name 之類顯示用）。
// LINE token / 銀行帳戶屬機敏資料，僅 admin 可看到。
function rowToVenuePublic(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    address: r.address || '',
    line_token: '',
    bank_institution_name: '',
    bank_branch_name: '',
    account_holder: '',
    account_number: '',
  };
}

router.get('/', requireAdminAuth, async (req, res) => {
  try {
    // Task #53：fire-and-forget（不阻塞回應；10 分鐘節流；cron 每 10 分鐘一次）
    kickoffSyncVenuesAsync();
    const r = await pool.query(`SELECT * FROM admin_venues ORDER BY id`);
    const isAdmin = req.adminUser?.role === 'admin';
    res.json(r.rows.map(isAdmin ? rowToVenueFull : rowToVenuePublic));
  } catch (err) {
    console.error('[admin/venues]', err);
    res.status(500).json({ error: 'list venues failed' });
  }
});

// Task #53：admin 立即同步 H05（同步等待結果）
router.post('/sync', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const result = await syncVenuesFromRagic();
    if (result && result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    console.error('[admin/venues/sync]', err);
    res.status(500).json({ error: 'sync failed' });
  }
});

router.patch('/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const patch = req.body || {};
    const cur = await pool.query(`SELECT * FROM admin_venues WHERE id = $1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'venue not found' });

    const fields = ['name', 'address', 'line_token', 'bank_institution_name',
                    'bank_branch_name', 'account_holder', 'account_number'];
    const values = fields.map((f) => patch[f] !== undefined ? patch[f] : cur.rows[0][f]);

    const r = await pool.query(
      `UPDATE admin_venues SET
         name = $2,
         address = $3,
         line_token = $4,
         bank_institution_name = $5,
         bank_branch_name = $6,
         account_holder = $7,
         account_number = $8,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    res.json(rowToVenueFull(r.rows[0]));
  } catch (err) {
    console.error('[admin/venues/:id PATCH]', err);
    res.status(500).json({ error: 'update venue failed' });
  }
});

module.exports = router;
