/**
 * 員工帳號管理 (F-A02) — Task #53 改造
 *  GET    /api/admin/staff              → 全部員工（純讀 DB；Ragic sync 改 fire-and-forget + cron）
 *                                         支援 ?status=active|inactive|all（預設 all）
 *                                                ?venueId=B|C|...
 *                                                ?role=admin|manager|staff|coach
 *                                                ?name=（substring）
 *                                                ?phone=（substring）
 *                                                ?senior=yes|no
 *  POST   /api/admin/staff/sync         → 立即同步 H01（同步等待結果）
 *  PATCH  /api/admin/staff/:id          → 更新角色/場館/資深/修課係數/啟用/兼任教練 LIFF 身分
 *                                         （翻轉 active / coach_active 會寫 overridden_at，避免 Ragic 覆蓋）
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const { syncStaffFromRagic, kickoffSyncStaffAsync } = require('../../services/ragicAdmin');

const router = express.Router();

function rowToStaff(r) {
  const hasCoachProfile = !!r.coach_id;
  const isDualRoleCoach = hasCoachProfile && r.role !== 'coach';
  const coachProfileStatus = !hasCoachProfile ? 'none' : (r.coach_active ? 'active' : 'inactive');
  const knownRoles = Array.from(new Set([r.role, ...(hasCoachProfile ? ['coach'] : [])]));
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    venue_id: r.venue_id,
    phone: r.phone,
    is_senior: !!r.is_senior,
    multiplier: Number(r.multiplier),
    active: !!r.active,
    has_coach_profile: hasCoachProfile,
    is_coach_profile: isDualRoleCoach,
    coach_profile_status: coachProfileStatus,
    known_roles: knownRoles,
    coach_id: r.coach_id || null,
    coach_active: hasCoachProfile ? !!r.coach_active : false,
  };
}

const STAFF_SELECT = `
  SELECT s.*,
         c.id AS coach_id,
         c.is_active AS coach_active
    FROM admin_staff s
    LEFT JOIN coaches c ON c.ragic_employee_id = s.id
`;

async function setCoachProfileActive(staffRow, active) {
  if (staffRow.role === 'coach') return;
  const desiredActive = !!active;

  if (!desiredActive) {
    await pool.query(
      `UPDATE coaches
          SET is_active = FALSE,
              active_overridden_at = NOW(),
              updated_at = NOW()
        WHERE ragic_employee_id = $1`,
      [staffRow.id]
    );
    return;
  }

  const phone = String(staffRow.phone || '').trim();
  if (!phone) {
    const err = new Error('啟用教練 LIFF 身分需要員工手機');
    err.statusCode = 400;
    throw err;
  }

  const bio = `${staffRow.name || staffRow.id} 兼任行政櫃檯與基礎課程教練。`;
  const inserted = await pool.query(
    `INSERT INTO coaches
       (ragic_employee_id, name, phone, email, is_senior, pricing_multiplier,
        specialties, bio_rich_text, is_active, intro_review_status, active_overridden_at)
     VALUES ($1, $2, $3, '', FALSE, 1.00, ARRAY['兼任櫃檯']::text[], $4, TRUE, 'draft', NOW())
     ON CONFLICT (ragic_employee_id) DO UPDATE SET
       name = EXCLUDED.name,
       phone = EXCLUDED.phone,
       is_active = TRUE,
       active_overridden_at = NOW(),
       updated_at = NOW()
     RETURNING id`,
    [staffRow.id, staffRow.name || staffRow.id, phone, bio]
  );

  const coachId = inserted.rows[0]?.id;
  if (coachId && staffRow.venue_id) {
    const venue = await pool.query(`SELECT id FROM venues WHERE id = $1 AND is_active = TRUE`, [staffRow.venue_id]);
    if (venue.rowCount) {
      await pool.query(
        `INSERT INTO coach_venues (coach_id, venue_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [coachId, staffRow.venue_id]
      );
    }
  }
}

router.get('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    // 不再阻塞：背景觸發 Ragic 同步（10 分鐘節流），下一次 GET 就會看到新資料
    kickoffSyncStaffAsync();

    const { status, venueId, role, name, phone, senior } = req.query;
    const where = [];
    const params = [];
    if (status === 'active') where.push(`s.active = TRUE`);
    else if (status === 'inactive') where.push(`s.active = FALSE`);
    if (venueId) { params.push(venueId); where.push(`s.venue_id = $${params.length}`); }
    if (role)    { params.push(role);    where.push(`s.role     = $${params.length}`); }
    if (name)    { params.push(`%${name}%`);  where.push(`s.name  ILIKE $${params.length}`); }
    if (phone)   { params.push(`%${phone}%`); where.push(`s.phone ILIKE $${params.length}`); }
    if (senior === 'yes') where.push(`s.is_senior = TRUE`);
    else if (senior === 'no') where.push(`(s.is_senior IS NULL OR s.is_senior = FALSE)`);

    const sql = `${STAFF_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.active DESC, s.id`;
    const r = await pool.query(sql, params);
    res.json(r.rows.map(rowToStaff));
  } catch (err) {
    console.error('[admin/staff]', err);
    res.status(500).json({ error: 'list staff failed' });
  }
});

router.post('/sync', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const result = await syncStaffFromRagic('manual');
    if (result && result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    console.error('[admin/staff/sync]', err);
    res.status(500).json({ error: 'sync failed' });
  }
});

router.patch('/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const patch = req.body || {};
    const cur = await pool.query(`SELECT * FROM admin_staff WHERE id = $1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'staff not found' });

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

    // 偵測 active 變更 → 標記 active_overridden_at（之後 Ragic 同步不再覆蓋）
    const activeChanged = patch.active != null && (!!patch.active) !== !!cur.rows[0].active;

    const r = await pool.query(
      `UPDATE admin_staff SET
          role = $2,
          venue_id = $3,
          is_senior = $4,
          multiplier = $5,
          active = $6,
          active_overridden_at = CASE WHEN $7::boolean THEN NOW() ELSE active_overridden_at END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, merged.role, merged.venue_id, merged.is_senior, merged.multiplier, merged.active, activeChanged]
    );

    // 連動 admin_users：若改 active，且該 staff name 對得到 admin_users，
    // 同步翻轉 is_active + 寫覆寫旗標（讓下輪 Ragic 同步不再覆蓋）
    if (activeChanged && r.rows[0].name) {
      await pool.query(
        `UPDATE admin_users
            SET is_active = $2,
                active_overridden_at = NOW()
          WHERE name = $1`,
        [r.rows[0].name, merged.active]
      );
    }
    if (patch.coach_active !== undefined && merged.role !== 'coach') {
      await setCoachProfileActive(r.rows[0], patch.coach_active);
    }
    const after = await pool.query(`${STAFF_SELECT} WHERE s.id = $1`, [r.rows[0].id]);
    res.json(rowToStaff(after.rows[0] || r.rows[0]));
  } catch (err) {
    console.error('[admin/staff/:id PATCH]', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'update staff failed' });
  }
});

module.exports = router;
