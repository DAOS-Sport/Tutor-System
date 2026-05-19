/**
 * 員工帳號管理 (F-A02) — Task #53 + Task #81
 *  GET    /api/admin/staff              → 全部員工（JOIN admin_users + coaches，單一事實來源）
 *                                         支援 ?status=active|inactive|all
 *                                                ?venueId / ?role / ?name / ?phone / ?senior=yes|no
 *  POST   /api/admin/staff              → 新建員工（admin_staff + admin_users + 可選 coaches，transaction）
 *                                         預設密碼 = 員工編號 (id)
 *  POST   /api/admin/staff/sync         → 立即同步 Ragic H01
 *  PATCH  /api/admin/staff/:id          → 更新角色/場館/姓名/手機/資深/修課係數/啟用
 *                                         同步連動 admin_users + coaches（transaction）
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const { syncStaffFromRagic, kickoffSyncStaffAsync } = require('../../services/ragicAdmin');

const router = express.Router();

const VALID_ROLES = ['admin', 'manager', 'staff', 'coach'];

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
    // Task #81：登入帳號連動狀態
    has_login_account: !!r.login_user_id,
    login_username: r.login_username || null,
    login_active: r.login_user_id ? !!r.login_is_active : false,
  };
}

const STAFF_SELECT = `
  SELECT s.*,
         c.id AS coach_id,
         c.is_active AS coach_active,
         u.id AS login_user_id,
         u.username AS login_username,
         u.is_active AS login_is_active
    FROM admin_staff s
    LEFT JOIN coaches c ON c.ragic_employee_id = s.id
    LEFT JOIN admin_users u ON (u.staff_id = s.id OR (u.staff_id IS NULL AND u.name = s.name))
`;

async function setCoachProfileActive(client, staffRow, active) {
  if (staffRow.role === 'coach') return;
  const desiredActive = !!active;

  if (!desiredActive) {
    await client.query(
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
  const inserted = await client.query(
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
    const venue = await client.query(`SELECT id FROM venues WHERE id = $1 AND is_active = TRUE`, [staffRow.venue_id]);
    if (venue.rowCount) {
      await client.query(
        `INSERT INTO coach_venues (coach_id, venue_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [coachId, staffRow.venue_id]
      );
    }
  }
}

// 新建 / 更新 role=coach 員工時，確保 coaches 表也有對應 row
async function ensureCoachRow(client, staffRow, opts = {}) {
  const phone = String(staffRow.phone || '').trim();
  if (!phone) return; // 沒手機無法建 LIFF coach 帳號，等之後補 phone 再建
  const multiplier = Number(opts.multiplier ?? staffRow.multiplier ?? 1);
  const isSenior = !!(opts.is_senior ?? staffRow.is_senior);
  const inserted = await client.query(
    `INSERT INTO coaches
       (ragic_employee_id, name, phone, email, is_senior, pricing_multiplier,
        specialties, bio_rich_text, is_active, intro_review_status)
     VALUES ($1, $2, $3, '', $4, $5, ARRAY[]::text[], '', TRUE, 'draft')
     ON CONFLICT (ragic_employee_id) DO UPDATE SET
       name = EXCLUDED.name,
       phone = EXCLUDED.phone,
       is_senior = EXCLUDED.is_senior,
       pricing_multiplier = EXCLUDED.pricing_multiplier,
       is_active = TRUE,
       active_overridden_at = NOW(),
       updated_at = NOW()
     RETURNING id`,
    [staffRow.id, staffRow.name || staffRow.id, phone, isSenior, multiplier]
  );
  const coachId = inserted.rows[0]?.id;
  if (coachId && staffRow.venue_id) {
    const venue = await client.query(`SELECT id FROM venues WHERE id = $1 AND is_active = TRUE`, [staffRow.venue_id]);
    if (venue.rowCount) {
      await client.query(
        `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
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

// Task #81：新建員工（admin_staff + admin_users + 可選 coaches，一個 transaction）
router.post('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const id = String(body.id || '').trim().toUpperCase();
    const name = String(body.name || '').trim();
    const role = String(body.role || '').trim();
    const venue_id = body.venue_id ? String(body.venue_id).trim() : null;
    const phone = String(body.phone || '').trim();
    const is_senior = role === 'coach' ? !!body.is_senior : false;
    const multiplier = role === 'coach' ? Number(body.multiplier ?? 1) : 1;
    const active = body.active !== false;

    if (!/^[A-Z][0-9A-Z]{1,9}$/.test(id)) {
      return res.status(400).json({ error: '員工編號格式：英文字母開頭，共 2–10 碼' });
    }
    if (!name) return res.status(400).json({ error: '姓名必填' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: '角色不合法' });
    if (role === 'coach') {
      if (!phone) return res.status(400).json({ error: '教練必須提供手機' });
      if (Number.isNaN(multiplier) || multiplier < 1.0 || multiplier > 1.5) {
        return res.status(400).json({ error: '修課係數需在 1.00–1.50 之間' });
      }
    }

    const dup = await client.query(`SELECT id FROM admin_staff WHERE id = $1`, [id]);
    if (dup.rowCount) return res.status(409).json({ error: `員工編號 ${id} 已存在` });
    const dupU = await client.query(`SELECT id FROM admin_users WHERE username = $1`, [id]);
    if (dupU.rowCount) return res.status(409).json({ error: `登入帳號 ${id} 已存在` });

    // 預設密碼 = 員工編號（首次登入後請改密碼，由 Task #82 處理 UI）
    const pwdHash = await bcrypt.hash(id, 10);
    const userId = `U_${id}`;
    const loginRole = role === 'coach' ? 'staff' : role; // admin_users.role CHECK 不含 coach，退到 staff

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO admin_staff (id, name, role, venue_id, phone, is_senior, multiplier, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, name, role, venue_id, phone, is_senior, multiplier, active]
    );
    await client.query(
      `INSERT INTO admin_users (id, username, password_hash, name, role, venue_id, is_active, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId, id, pwdHash, name, loginRole, venue_id, active, id]
    );
    if (role === 'coach') {
      await ensureCoachRow(client, { id, name, phone, venue_id, multiplier, is_senior }, { multiplier, is_senior });
    }
    await client.query('COMMIT');

    const after = await pool.query(`${STAFF_SELECT} WHERE s.id = $1`, [id]);
    res.status(201).json({
      ...rowToStaff(after.rows[0]),
      default_password_hint: id, // 提供前端顯示 default password 提示（值 = 員工編號）
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    console.error('[admin/staff POST]', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : '建立員工失敗' });
  } finally {
    client.release();
  }
});

router.patch('/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const patch = req.body || {};
    const cur = await client.query(`SELECT * FROM admin_staff WHERE id = $1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'staff not found' });

    if (patch.role && !VALID_ROLES.includes(patch.role)) {
      return res.status(400).json({ error: '角色不合法' });
    }
    if (patch.role === 'coach' && patch.multiplier != null) {
      const m = Number(patch.multiplier);
      if (Number.isNaN(m) || m < 1.0 || m > 1.5) {
        return res.status(400).json({ error: '修課係數需在 1.00–1.50 之間' });
      }
    }

    const merged = {
      name: patch.name !== undefined ? String(patch.name).trim() : cur.rows[0].name,
      phone: patch.phone !== undefined ? String(patch.phone || '').trim() : cur.rows[0].phone,
      role: patch.role ?? cur.rows[0].role,
      venue_id: patch.venue_id !== undefined ? patch.venue_id : cur.rows[0].venue_id,
      is_senior: patch.is_senior != null ? !!patch.is_senior : !!cur.rows[0].is_senior,
      multiplier: patch.multiplier != null ? Number(patch.multiplier) : Number(cur.rows[0].multiplier),
      active: patch.active != null ? !!patch.active : !!cur.rows[0].active,
    };
    if (!merged.name) return res.status(400).json({ error: '姓名必填' });
    // role=coach 必須要有 phone，否則 ensureCoachRow 會 noop 而留下 inconsistent state
    if (merged.role === 'coach' && !merged.phone) {
      return res.status(400).json({ error: '教練角色必須有手機（用於建立教練 LIFF 紀錄）' });
    }

    const activeChanged = patch.active != null && (!!patch.active) !== !!cur.rows[0].active;
    const roleChanged = patch.role != null && patch.role !== cur.rows[0].role;

    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE admin_staff SET
          name = $2,
          phone = $3,
          role = $4,
          venue_id = $5,
          is_senior = $6,
          multiplier = $7,
          active = $8,
          active_overridden_at = CASE WHEN $9::boolean THEN NOW() ELSE active_overridden_at END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, merged.name, merged.phone, merged.role, merged.venue_id,
       merged.is_senior, merged.multiplier, merged.active, activeChanged]
    );

    // 連動 admin_users — 只用 staff_id 對應，避免名字相同的不同人被連動寫入（auth 安全）
    // 舊資料由 bootstrap 的「唯一同名」backfill 連起來；沒連起來的 orphan 帳號不會被本 PATCH 影響
    const loginRole = merged.role === 'coach' ? 'staff' : merged.role;
    await client.query(
      `UPDATE admin_users
          SET name = $2,
              role = $3,
              venue_id = $4,
              is_active = $5,
              active_overridden_at = CASE WHEN $6::boolean THEN NOW() ELSE active_overridden_at END,
              updated_at = NOW()
        WHERE staff_id = $1`,
      [id, merged.name, loginRole, merged.venue_id, merged.active, activeChanged]
    );

    // 連動 coaches：role 變成 coach → 確保有 coach row；role 從 coach 轉為其它 → 軟下架
    if (merged.role === 'coach') {
      await ensureCoachRow(client, r.rows[0]);
      // 同步 coaches 基本欄位
      await client.query(
        `UPDATE coaches
            SET name = $2,
                phone = $3,
                is_senior = $4,
                pricing_multiplier = $5,
                is_active = $6,
                updated_at = NOW()
          WHERE ragic_employee_id = $1`,
        [id, merged.name, merged.phone, merged.is_senior, merged.multiplier, merged.active]
      );
    } else if (roleChanged && cur.rows[0].role === 'coach') {
      await client.query(
        `UPDATE coaches
            SET is_active = FALSE, active_overridden_at = NOW(), updated_at = NOW()
          WHERE ragic_employee_id = $1`,
        [id]
      );
    } else if (activeChanged) {
      // role 沒變，只翻 active：同步 coaches.is_active（若該 staff 有對應 coach 紀錄）
      await client.query(
        `UPDATE coaches
            SET is_active = $2, active_overridden_at = NOW(), updated_at = NOW()
          WHERE ragic_employee_id = $1`,
        [id, merged.active]
      );
    }

    if (patch.coach_active !== undefined && merged.role !== 'coach') {
      await setCoachProfileActive(client, r.rows[0], patch.coach_active);
    }
    await client.query('COMMIT');

    const after = await pool.query(`${STAFF_SELECT} WHERE s.id = $1`, [r.rows[0].id]);
    res.json(rowToStaff(after.rows[0] || r.rows[0]));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    console.error('[admin/staff/:id PATCH]', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'update staff failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
