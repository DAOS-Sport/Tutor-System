/**
 * 員工帳號管理 (F-A02)
 *  GET    /api/admin/staff           → 全部員工（best-effort 先 sync Ragic H01）
 *  PATCH  /api/admin/staff/:id       → 更新角色 / 場館 / 資深 / 修課係數 / 啟用
 *
 * mock.js 回傳 shape：
 *   { id, name, role, venue_id, phone, is_senior, multiplier, active }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const { syncStaffFromRagic } = require('../../services/ragicAdmin');

const router = express.Router();

function rowToStaff(r) {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    venue_id: r.venue_id,
    phone: r.phone,
    is_senior: !!r.is_senior,
    multiplier: Number(r.multiplier),
    active: !!r.active,
  };
}

// 員工清單只有「系統管理員」可看（含 phone / multiplier 等敏感欄位）。
// manager / staff 在 UI 也沒有任何頁面呼叫此 endpoint。
router.get('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    // best-effort：把 Ragic H01 在職員工 upsert 進來；無 Ragic credential 時 skip
    await syncStaffFromRagic();
    const r = await pool.query(`SELECT * FROM admin_staff ORDER BY id`);
    res.json(r.rows.map(rowToStaff));
  } catch (err) {
    console.error('[admin/staff]', err);
    res.status(500).json({ error: 'list staff failed' });
  }
});

router.patch('/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const patch = req.body || {};
    const cur = await pool.query(`SELECT * FROM admin_staff WHERE id = $1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'staff not found' });

    // 教練修課係數限制 1.00–1.50
    if (patch.role === 'coach' && patch.multiplier != null) {
      const m = Number(patch.multiplier);
      if (Number.isNaN(m) || m < 1.0 || m > 1.5) {
        return res.status(400).json({ error: '修課係數需在 1.00–1.50 之間' });
      }
    }

    const merged = {
      role: patch.role ?? cur.rows[0].role,
      venue_id: patch.venue_id !== undefined ? patch.venue_id : cur.rows[0].venue_id,
      is_senior: patch.is_senior != null ? !!patch.is_senior : !!cur.rows[0].is_senior,
      multiplier: patch.multiplier != null ? Number(patch.multiplier) : Number(cur.rows[0].multiplier),
      active: patch.active != null ? !!patch.active : !!cur.rows[0].active,
    };

    const r = await pool.query(
      `UPDATE admin_staff SET
          role = $2,
          venue_id = $3,
          is_senior = $4,
          multiplier = $5,
          active = $6,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, merged.role, merged.venue_id, merged.is_senior, merged.multiplier, merged.active]
    );
    res.json(rowToStaff(r.rows[0]));
  } catch (err) {
    console.error('[admin/staff/:id PATCH]', err);
    res.status(500).json({ error: 'update staff failed' });
  }
});

module.exports = router;
