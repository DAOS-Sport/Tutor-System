/**
 * 員工帳號管理 (F-A02) — Task #51 已遷移到單一 employees 表
 *  GET    /api/admin/staff           → 全部員工（best-effort 先 sync Ragic H01）
 *  PATCH  /api/admin/staff/:id       → 更新角色 / 場館 / 資深 / 修課係數 / 啟用
 *
 * Response shape（向後相容 admin/src/api/mock.js）：
 *   { id, name, role, venue_id, phone, is_senior, multiplier, active }
 *   - role 是 legacy 單值（admin/manager/staff/coach），由 employees.roles[] 經
 *     deriveLegacyRole() 取最高優先級轉出來。
 *   - 多角色會在後續 multi-role UI 任務支援；目前 UI 單選，PATCH role=X 會將
 *     roles[] 整個取代為 [LEGACY_TO_EMPLOYEE[X]]，多餘角色會被覆蓋（已知取捨）。
 */
const express = require('express');
const { pool } = require('../../models/db');
const {
  requireAdminAuth, requireAdminRole,
  deriveLegacyRole, LEGACY_TO_EMPLOYEE,
} = require('../../middlewares/adminAuth');
const { syncStaffFromRagic } = require('../../services/ragicAdmin');

const router = express.Router();

function rowToStaff(r) {
  return {
    id: r.id,
    name: r.name,
    role: deriveLegacyRole(r.roles || []),
    venue_id: r.venue_id,
    phone: r.phone,
    is_senior: !!r.is_senior,
    multiplier: Number(r.pricing_multiplier),
    active: !!r.is_active,
  };
}

router.get('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    await syncStaffFromRagic();
    const r = await pool.query(`SELECT * FROM employees ORDER BY name, id`);
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
    const cur = await pool.query(`SELECT * FROM employees WHERE id = $1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'staff not found' });

    if (patch.role === 'coach' && patch.multiplier != null) {
      const m = Number(patch.multiplier);
      if (Number.isNaN(m) || m < 1.0 || m > 1.5) {
        return res.status(400).json({ error: '修課係數需在 1.00–1.50 之間' });
      }
    }

    let nextRoles = cur.rows[0].roles || [];
    if (patch.role !== undefined && patch.role !== null) {
      const mapped = LEGACY_TO_EMPLOYEE[patch.role];
      if (!mapped) return res.status(400).json({ error: `未知角色: ${patch.role}` });
      nextRoles = [mapped];
    }

    const merged = {
      roles: nextRoles,
      venue_id: patch.venue_id !== undefined ? patch.venue_id : cur.rows[0].venue_id,
      is_senior: patch.is_senior != null ? !!patch.is_senior : !!cur.rows[0].is_senior,
      multiplier: patch.multiplier != null ? Number(patch.multiplier) : Number(cur.rows[0].pricing_multiplier),
      is_active: patch.active != null ? !!patch.active : !!cur.rows[0].is_active,
    };

    const r = await pool.query(
      `UPDATE employees SET
          roles = $2,
          venue_id = $3,
          is_senior = $4,
          pricing_multiplier = $5,
          is_active = $6,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, merged.roles, merged.venue_id, merged.is_senior, merged.multiplier, merged.is_active]
    );
    res.json(rowToStaff(r.rows[0]));
  } catch (err) {
    console.error('[admin/staff/:id PATCH]', err);
    res.status(500).json({ error: 'update staff failed' });
  }
});

module.exports = router;
