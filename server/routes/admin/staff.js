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
const lineService = require('../../services/line');

const router = express.Router();

const VALID_ROLES = ['admin', 'manager', 'staff', 'coach'];

function rowToStaff(r) {
  const hasCoachProfile = !!r.coach_id;
  const isDualRoleCoach = hasCoachProfile && r.role !== 'coach';
  const coachProfileStatus = !hasCoachProfile ? 'none' : (r.coach_active ? 'active' : 'inactive');
  const knownRoles = Array.from(new Set([r.role, ...(hasCoachProfile ? ['coach'] : [])]));
  // Task #90：venue_ids 是真實多場館清單；venue_id 維持作為「第一筆」相容
  const venueIds = Array.isArray(r.venue_ids) ? r.venue_ids.filter(Boolean) : [];
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    venue_id: r.venue_id || venueIds[0] || null,
    venue_ids: venueIds,
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
         u.is_active AS login_is_active,
         COALESCE(
           (SELECT array_agg(sv.venue_id ORDER BY sv.venue_id)
              FROM admin_staff_venues sv WHERE sv.staff_id = s.id),
           CASE WHEN s.venue_id IS NOT NULL AND s.venue_id <> ''
                THEN ARRAY[s.venue_id]::text[] ELSE ARRAY[]::text[] END
         ) AS venue_ids
    FROM admin_staff s
    LEFT JOIN coaches c ON c.ragic_employee_id = s.id
    LEFT JOIN admin_users u ON (u.staff_id = s.id OR (u.staff_id IS NULL AND u.name = s.name))
`;

/** Task #90：把 admin_staff_venues 與 coach_venues 同步成 venueIds 清單（idempotent）。 */
async function syncStaffVenues(client, staffId, venueIds) {
  const list = Array.from(new Set((venueIds || []).filter(Boolean).map(String)));
  await client.query(`DELETE FROM admin_staff_venues WHERE staff_id = $1`, [staffId]);
  for (const vid of list) {
    await client.query(
      `INSERT INTO admin_staff_venues (staff_id, venue_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [staffId, vid]
    );
  }
  return list;
}

async function syncCoachVenues(client, coachId, venueIds) {
  const list = Array.from(new Set((venueIds || []).filter(Boolean).map(String)));
  if (!coachId) return;
  // 只插入確實 active 的場館；不刪原有資料時，需避免「移除一個場館後 coach_venues 還留著」
  // 策略：先 DELETE 該 coach 全部，再依目前 list 寫回（保持單一事實 = staff 多場館）
  await client.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [coachId]);
  if (!list.length) return;
  const r = await client.query(
    `SELECT id FROM venues WHERE id = ANY($1::text[]) AND is_active = TRUE`,
    [list]
  );
  for (const row of r.rows) {
    await client.query(
      `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [coachId, row.id]
    );
  }
}

function pickVenueIds(body, fallbackVenueId) {
  if (Array.isArray(body?.venue_ids)) {
    return Array.from(new Set(body.venue_ids.filter(Boolean).map((s) => String(s).trim())));
  }
  if (body?.venue_id) return [String(body.venue_id).trim()];
  if (fallbackVenueId) return [String(fallbackVenueId).trim()];
  return [];
}

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
  // Task #90：把 staff 的多場館展開寫入 coach_venues
  const venueIds = Array.isArray(staffRow.venue_ids) && staffRow.venue_ids.length
    ? staffRow.venue_ids
    : (staffRow.venue_id ? [staffRow.venue_id] : []);
  if (coachId && venueIds.length) {
    await syncCoachVenues(client, coachId, venueIds);
  }
}

// 新建 / 更新 role=coach 員工時，確保 coaches 表也有對應 row
async function ensureCoachRow(client, staffRow, opts = {}) {
  const phone = String(staffRow.phone || '').trim();
  if (!phone) return; // 沒手機無法建 LIFF coach 帳號，等之後補 phone 再建
  const multiplier = Number(opts.multiplier ?? staffRow.multiplier ?? 1);
  const isSenior = !!(opts.is_senior ?? staffRow.is_senior);
  const isActive = opts.is_active != null ? !!opts.is_active : (staffRow.active != null ? !!staffRow.active : true);
  const inserted = await client.query(
    `INSERT INTO coaches
       (ragic_employee_id, name, phone, email, is_senior, pricing_multiplier,
        specialties, bio_rich_text, is_active, intro_review_status, active_overridden_at)
     VALUES ($1, $2, $3, '', $4, $5, ARRAY[]::text[], '', $6, 'draft', NOW())
     ON CONFLICT (ragic_employee_id) DO UPDATE SET
       name = EXCLUDED.name,
       phone = EXCLUDED.phone,
       is_senior = EXCLUDED.is_senior,
       pricing_multiplier = EXCLUDED.pricing_multiplier,
       is_active = EXCLUDED.is_active,
       active_overridden_at = NOW(),
       updated_at = NOW()
     RETURNING id`,
    [staffRow.id, staffRow.name || staffRow.id, phone, isSenior, multiplier, isActive]
  );
  const coachId = inserted.rows[0]?.id;
  // Task #90：把 staff 的多場館展開寫入 coach_venues（取代單筆 INSERT）
  const venueIds = Array.isArray(staffRow.venue_ids) && staffRow.venue_ids.length
    ? staffRow.venue_ids
    : (staffRow.venue_id ? [staffRow.venue_id] : []);
  if (coachId && venueIds.length) {
    await syncCoachVenues(client, coachId, venueIds);
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
    // Task #90：場館篩選 = 「該員工的所屬場館清單 包含 venueId」
    if (venueId) {
      params.push(venueId);
      where.push(`(s.venue_id = $${params.length} OR EXISTS (
                     SELECT 1 FROM admin_staff_venues sv
                      WHERE sv.staff_id = s.id AND sv.venue_id = $${params.length}))`);
    }
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
    const venue_ids = pickVenueIds(body);
    const venue_id = venue_ids[0] || null;  // 相容：admin_staff.venue_id 留第一筆
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

    // username 策略：優先 phone，被佔走則 fallback 員工編號，再被佔走則 加 _01 _02 數字後綴
    async function resolveUsername() {
      const candidates = [];
      if (phone) candidates.push(phone);
      candidates.push(id);
      for (const cand of candidates) {
        const exists = await client.query(`SELECT 1 FROM admin_users WHERE username = $1`, [cand]);
        if (!exists.rowCount) return cand;
      }
      for (let i = 1; i < 100; i++) {
        const cand = `${id}_${String(i).padStart(2, '0')}`;
        const exists = await client.query(`SELECT 1 FROM admin_users WHERE username = $1`, [cand]);
        if (!exists.rowCount) return cand;
      }
      throw Object.assign(new Error('無法產生唯一的登入帳號'), { statusCode: 409 });
    }
    const username = await resolveUsername();

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
      [userId, username, pwdHash, name, loginRole, venue_id, active, id]
    );
    await syncStaffVenues(client, id, venue_ids);
    if (role === 'coach') {
      // 把 create 表單的 active 傳進去，避免新建一個 active=false 的教練卻在 coaches 表是 TRUE
      await ensureCoachRow(client, { id, name, phone, venue_id, venue_ids, active }, { multiplier, is_senior, is_active: active });
    }
    await client.query('COMMIT');

    const after = await pool.query(`${STAFF_SELECT} WHERE s.id = $1`, [id]);
    res.status(201).json({
      ...rowToStaff(after.rows[0]),
      default_password_hint: id,    // 預設密碼（= 員工編號）
      login_username: username,     // 實際使用的登入帳號（可能 = phone or id or id_NN）
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

    // Task #90：先撈現有 venue_ids（若 patch 沒帶就維持現狀）
    const existingVenuesQ = await client.query(
      `SELECT array_agg(venue_id ORDER BY venue_id) AS ids FROM admin_staff_venues WHERE staff_id = $1`,
      [id]
    );
    const existingVenueIds = (existingVenuesQ.rows[0]?.ids || []).filter(Boolean);
    const venueIdsTouched = Array.isArray(patch.venue_ids) || patch.venue_id !== undefined;
    const newVenueIds = venueIdsTouched
      ? pickVenueIds(patch)
      : (existingVenueIds.length ? existingVenueIds : (cur.rows[0].venue_id ? [cur.rows[0].venue_id] : []));

    const merged = {
      name: patch.name !== undefined ? String(patch.name).trim() : cur.rows[0].name,
      phone: patch.phone !== undefined ? String(patch.phone || '').trim() : cur.rows[0].phone,
      role: patch.role ?? cur.rows[0].role,
      venue_id: newVenueIds[0] || null,
      venue_ids: newVenueIds,
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

    // Task #90：同步 admin_staff_venues
    if (venueIdsTouched) {
      await syncStaffVenues(client, id, newVenueIds);
    }

    // 連動 coaches：role 變成 coach → 確保有 coach row；role 從 coach 轉為其它 → 軟下架
    if (merged.role === 'coach') {
      await ensureCoachRow(client, { ...r.rows[0], venue_ids: newVenueIds }, { is_active: merged.active });
      // 同步 coaches 基本欄位 + active_overridden_at（避免後台啟停被 Ragic 覆寫）
      await client.query(
        `UPDATE coaches
            SET name = $2,
                phone = $3,
                is_senior = $4,
                pricing_multiplier = $5,
                is_active = $6,
                active_overridden_at = CASE WHEN $7::boolean THEN NOW() ELSE active_overridden_at END,
                updated_at = NOW()
          WHERE ragic_employee_id = $1`,
        [id, merged.name, merged.phone, merged.is_senior, merged.multiplier, merged.active, activeChanged]
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

// Task #82：admin 重設員工密碼為員工編號 + 推 LINE 通知
router.post('/:id/reset-password', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const staffRes = await pool.query(
      `SELECT s.id, s.name, s.venue_id, c.line_uid AS coach_line_uid
         FROM admin_staff s
         LEFT JOIN coaches c ON c.ragic_employee_id = s.id
        WHERE s.id = $1`,
      [id]
    );
    const staff = staffRes.rows[0];
    if (!staff) return res.status(404).json({ error: '找不到該員工' });

    const userRes = await pool.query(
      `SELECT id, line_uid FROM admin_users WHERE staff_id = $1`,
      [id]
    );
    const adminUser = userRes.rows[0];
    if (!adminUser) {
      return res.status(404).json({ error: '該員工尚無後台登入帳號' });
    }

    const newHash = await bcrypt.hash(String(id), 10);
    await pool.query(
      `UPDATE admin_users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
      [adminUser.id, newHash]
    );

    // 推 LINE 通知（best-effort）：優先用 admin_users.line_uid（後台帳號自身綁定的 LINE），
    // 若未綁定且該員工同時是教練，fallback 撈 coaches.line_uid
    let notified = false;
    let notifyError = null;
    const lineUid = adminUser.line_uid || staff.coach_line_uid;
    if (lineUid && staff.venue_id) {
      try {
        const base = (process.env.ADMIN_URL || '').replace(/\/$/, '');
        const loginUrl = base ? `${base}/admin/login` : undefined;
        const messages = lineService.templates.adminPasswordReset({
          employeeName: staff.name,
          employeeId: staff.id,
          loginUrl,
        });
        await lineService.pushMessage(lineUid, messages, staff.venue_id);
        notified = true;
      } catch (err) {
        notifyError = err.message || String(err);
        console.warn('[admin/staff/reset-password] LINE 推送失敗', staff.id, notifyError);
      }
    } else {
      console.warn('[admin/staff/reset-password] 該員工未綁定 LINE 或無場館，略過通知', staff.id);
    }

    res.json({
      ok: true,
      staff_id: staff.id,
      staff_name: staff.name,
      notified,
      notify_error: notifyError,
    });
  } catch (err) {
    console.error('[admin/staff/:id/reset-password]', err);
    res.status(500).json({ error: '重設密碼失敗' });
  }
});

module.exports = router;
