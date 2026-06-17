/**
 * 員工帳號管理 (F-A02) — Task #53 + Task #81 + Task #91
 *  GET    /api/admin/staff              → 全部員工（JOIN admin_users + coaches，單一事實來源）
 *                                         支援 ?status=active|inactive|all
 *                                                ?venueId / ?role / ?name / ?phone / ?senior=yes|no
 *  GET    /api/admin/staff/coaches      → Task #91：給 EditEnrollmentModal 等內部 lookup 用
 *                                         回 [{ id: coachUUID, ragic_employee_id, name, venue_ids }]
 *                                         支援 ?venueId=&status=active|inactive|all
 *  GET    /api/admin/staff/:id          → 單筆詳細（含 coach_profile + bio_media，給編輯彈窗載入）
 *  POST   /api/admin/staff              → 新建員工（admin_staff + admin_users + 可選 coaches，transaction）
 *                                         預設密碼 = 員工編號 (id)
 *  POST   /api/admin/staff/sync         → 立即同步 Ragic H01
 *  PATCH  /api/admin/staff/:id          → 更新角色/場館/姓名/手機/資深/修課係數/啟用
 *                                         + 可選 coach_profile { bio_rich_text, specialties, email,
 *                                                                intro_review_status, is_active(=coach_active) }
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
const MULTIPLIER_MIN = 1.00;
const MULTIPLIER_MAX = 1.50;

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
    // Task #95：來自 Ragic 的員工，H01 同步欄位（姓名/手機/場館）鎖定為唯讀（修改請洽 HR）
    ragic_locked: !!r.ragic_record_id,
    is_senior: !!r.is_senior,
    multiplier: Number(r.multiplier),
    active: !!r.active,
    has_coach_profile: hasCoachProfile,
    is_coach_profile: isDualRoleCoach,
    coach_profile_status: coachProfileStatus,
    known_roles: knownRoles,
    coach_id: r.coach_id || null,
    coach_active: hasCoachProfile ? !!r.coach_active : false,
    // Task #91：合併教練設定後，列表也回傳教練欄位摘要供前端表格／搜尋使用
    coach_profile: hasCoachProfile ? {
      coach_id: r.coach_id,
      is_active: !!r.coach_active,
      bio_rich_text: r.coach_bio || '',
      specialties: Array.isArray(r.coach_specialties) ? r.coach_specialties : [],
      email: r.coach_email || '',
      intro_review_status: r.coach_intro_status || 'draft',
      intro_review_note: r.coach_intro_note || '',
      line_bound: !!r.coach_line_uid,
    } : null,
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
         c.bio_rich_text AS coach_bio,
         c.specialties AS coach_specialties,
         c.email AS coach_email,
         c.intro_review_status AS coach_intro_status,
         c.intro_review_note AS coach_intro_note,
         c.line_uid AS coach_line_uid,
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

/**
 * Task #91：套用 coach_profile 欄位（admin 在員工編輯彈窗中填入）。
 * - bio_rich_text / specialties / email：直接覆寫 coaches
 * - intro_review_status：admin 改回 'draft' 可重置流程（一般審核走 /admin/learn/intros/*）
 * 注意：此函式只更新 coach 內容欄位，不處理 is_active／場館（由上層處理）。
 */
async function applyCoachProfilePatch(client, staffId, profile) {
  if (!profile || typeof profile !== 'object') return;
  const sets = [];
  const vals = [staffId];
  function add(col, val) {
    vals.push(val);
    sets.push(`${col} = $${vals.length}`);
  }
  if (profile.bio_rich_text !== undefined) add('bio_rich_text', String(profile.bio_rich_text || ''));
  if (profile.email !== undefined) add('email', String(profile.email || ''));
  if (Array.isArray(profile.specialties)) {
    const arr = profile.specialties.map((s) => String(s).trim()).filter(Boolean);
    add('specialties', arr);
  }
  if (profile.intro_review_status !== undefined) {
    const valid = ['draft', 'pending_review', 'published', 'rejected'];
    if (!valid.includes(profile.intro_review_status)) {
      const e = new Error(`intro_review_status 不合法：${profile.intro_review_status}`);
      e.statusCode = 400;
      throw e;
    }
    add('intro_review_status', profile.intro_review_status);
  }
  if (!sets.length) return;
  sets.push(`updated_at = NOW()`);
  await client.query(
    `UPDATE coaches SET ${sets.join(', ')} WHERE ragic_employee_id = $1`,
    vals
  );
}

async function setCoachProfileActive(client, staffRow, active, opts = {}) {
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

  // Task #91 fix：dual-role 教練啟用時 honor staff 的 is_senior / multiplier，
  // 否則第一次啟用會被強制歸 0 / 1.00，編輯彈窗改的係數 / 資深旗會被吃掉。
  const isSenior = opts.is_senior != null ? !!opts.is_senior : !!staffRow.is_senior;
  const multiplier = opts.multiplier != null
    ? Number(opts.multiplier)
    : Number(staffRow.multiplier || 1);

  const bio = `${staffRow.name || staffRow.id} 兼任行政櫃檯與基礎課程教練。`;
  const inserted = await client.query(
    `INSERT INTO coaches
       (ragic_employee_id, name, phone, email, is_senior, pricing_multiplier,
        specialties, bio_rich_text, is_active, intro_review_status, active_overridden_at)
     VALUES ($1, $2, $3, '', $4, $5, ARRAY['兼任櫃檯']::text[], $6, TRUE, 'draft', NOW())
     ON CONFLICT (ragic_employee_id) DO UPDATE SET
       name = EXCLUDED.name,
       phone = EXCLUDED.phone,
       is_senior = EXCLUDED.is_senior,
       pricing_multiplier = EXCLUDED.pricing_multiplier,
       is_active = TRUE,
       active_overridden_at = NOW(),
       updated_at = NOW()
     RETURNING id`,
    [staffRow.id, staffRow.name || staffRow.id, phone, isSenior, multiplier, bio]
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

// 新建 / 更新 role=coach 員工時，確保 coaches 表也有對應 row（Task #91：可一併寫入 coach_profile）
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
  // Task #91：若同一次請求帶了 coach_profile，於同交易內套用
  if (opts.coach_profile) {
    await applyCoachProfilePatch(client, staffRow.id, opts.coach_profile);
  }
  return coachId;
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

/**
 * Task #91：教練清單 lookup（給 EditEnrollmentModal 等需要 coaches.id UUID 的內部用途）。
 * 取代 GET /api/admin/coaches?venueId=...&status=active（後者已 410）。
 * 回 { id (coach UUID), ragic_employee_id, name, phone, is_senior, pricing_multiplier, venue_ids[], is_active }
 */
router.get('/coaches',
  requireAdminAuth,
  requireAdminRole('admin', 'manager', 'staff'),
  async (req, res) => {
    try {
      const { venueId, status = 'active' } = req.query;
      // Task #91 fix：包含 dual-role 兼任教練（s.role != 'coach' 但 c.id 存在且 c.is_active=TRUE）。
      // 否則「行政櫃檯啟用教練 LIFF 身分」之後，報名 / 排課的教練下拉看不到他。
      const where = [`c.id IS NOT NULL`, `(s.role = 'coach' OR c.is_active = TRUE)`];
      const params = [];
      if (status === 'active') {
        where.push(`s.active = TRUE`);
        where.push(`c.is_active = TRUE`);
      } else if (status === 'inactive') {
        where.push(`(s.active = FALSE OR c.is_active = FALSE)`);
      }
      if (venueId) {
        params.push(venueId);
        where.push(`EXISTS (SELECT 1 FROM coach_venues cv WHERE cv.coach_id = c.id AND cv.venue_id = $${params.length})`);
      }
      const sql = `
        SELECT c.id, c.ragic_employee_id, c.name, c.phone,
               c.is_senior, c.pricing_multiplier, c.is_active,
               COALESCE(
                 (SELECT array_agg(cv.venue_id ORDER BY cv.venue_id)
                    FROM coach_venues cv WHERE cv.coach_id = c.id),
                 ARRAY[]::text[]
               ) AS venue_ids
          FROM admin_staff s
          JOIN coaches c ON c.ragic_employee_id = s.id
         WHERE ${where.join(' AND ')}
         ORDER BY c.name`;
      const r = await pool.query(sql, params);
      res.json(r.rows.map((row) => ({
        id: row.id,
        ragic_employee_id: row.ragic_employee_id,
        name: row.name,
        phone: row.phone,
        is_senior: !!row.is_senior,
        pricing_multiplier: Number(row.pricing_multiplier),
        multiplier: Number(row.pricing_multiplier),
        is_active: !!row.is_active,
        venue_ids: row.venue_ids || [],
      })));
    } catch (err) {
      console.error('[admin/staff/coaches]', err);
      res.status(500).json({ error: 'list coach lookup failed' });
    }
  }
);

/**
 * Task #91：單筆員工詳細（給編輯彈窗 prefetch 完整 coach_profile + bio_media）
 */
router.get('/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(`${STAFF_SELECT} WHERE s.id = $1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'staff not found' });
    const staff = rowToStaff(r.rows[0]);
    let bio_media = [];
    if (staff.coach_id) {
      const m = await pool.query(
        `SELECT id, media_type, storage_url, alt_text, sort_order
           FROM coach_bio_media WHERE coach_id = $1 ORDER BY sort_order, id`,
        [staff.coach_id]
      );
      bio_media = m.rows;
    }
    res.json({ ...staff, bio_media });
  } catch (err) {
    console.error('[admin/staff/:id GET]', err);
    res.status(500).json({ error: 'get staff failed' });
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
    const coachProfile = body.coach_profile || null;

    if (!/^[A-Z][0-9A-Z]{1,9}$/.test(id)) {
      return res.status(400).json({ error: '員工編號格式：英文字母開頭，共 2–10 碼' });
    }
    if (!name) return res.status(400).json({ error: '姓名必填' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: '角色不合法' });
    if (role === 'coach') {
      if (!phone) return res.status(400).json({ error: '教練必須提供手機' });
      if (Number.isNaN(multiplier) || multiplier < MULTIPLIER_MIN || multiplier > MULTIPLIER_MAX) {
        return res.status(400).json({ error: `修課係數需在 ${MULTIPLIER_MIN.toFixed(2)}–${MULTIPLIER_MAX.toFixed(2)} 之間` });
      }
    }

    const dup = await client.query(`SELECT id FROM admin_staff WHERE id = $1`, [id]);
    if (dup.rowCount) return res.status(409).json({ error: `員工編號 ${id} 已存在` });

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

    const pwdHash = await bcrypt.hash(id, 10);
    const userId = `U_${id}`;
    const loginRole = role === 'coach' ? 'staff' : role;

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
      await ensureCoachRow(client,
        { id, name, phone, venue_id, venue_ids, active },
        { multiplier, is_senior, is_active: active, coach_profile: coachProfile });
    }
    await client.query('COMMIT');

    const after = await pool.query(`${STAFF_SELECT} WHERE s.id = $1`, [id]);
    res.status(201).json({
      ...rowToStaff(after.rows[0]),
      default_password_hint: id,
      login_username: username,
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
    // Multiplier 範圍校驗：只要這次請求會讓 coach.pricing_multiplier 生效就檢查。
    // 觸發條件（涵蓋所有教練生效路徑，含序列攻擊：先存壞值 → 再啟用 coach_active）：
    //   1) patch.role === 'coach'
    //   2) patch.coach_active === true（啟用 dual-role）
    //   3) 存在 coach row（不論 is_active；可能稍後被啟用）且 patch 帶 multiplier
    //   4) patch.coach_active === true 且本次未帶 multiplier → 校驗 effective multiplier
    //      （= patch.multiplier ?? admin_staff.multiplier 現值）以避免「先 PATCH 壞值
    //      不被擋（因 coach 仍 inactive）→ 再 PATCH coach_active 啟用，繞過邏輯」
    {
      const existingCoach = await client.query(
        `SELECT id, is_active FROM coaches WHERE ragic_employee_id = $1 LIMIT 1`, [id]
      );
      const hasCoachRow = existingCoach.rowCount > 0;
      const willTakeEffect =
        patch.role === 'coach' ||
        patch.coach_active === true ||
        (hasCoachRow && patch.multiplier != null) ||
        (cur.rows[0].role === 'coach' && patch.multiplier != null);

      if (willTakeEffect) {
        const effective = patch.multiplier != null
          ? Number(patch.multiplier)
          : Number(cur.rows[0].multiplier ?? 1);
        if (Number.isNaN(effective) || effective < MULTIPLIER_MIN || effective > MULTIPLIER_MAX) {
          return res.status(400).json({
            error: `修課係數需在 ${MULTIPLIER_MIN.toFixed(2)}–${MULTIPLIER_MAX.toFixed(2)} 之間`,
            code: 'MULTIPLIER_OUT_OF_RANGE',
          });
        }
      }
    }

    // Task #95（Ragic 權威政策）：來自 Ragic 的員工（ragic_record_id 非空）其 H01 同步欄位
    // （姓名/手機/場館）一律以 Ragic 為準 — 後端直接忽略這些欄位的修改（前端 UI 已鎖定，
    // 此處為 defense-in-depth）。異動請 HR 至 Ragic 更新，下一輪同步自動帶回；
    // 否則本地改了之後，每輪同步都會把 Ragic 舊值當差異 stage 回待審核，永遠調不完。
    const ragicLocked = !!cur.rows[0].ragic_record_id;

    const existingVenuesQ = await client.query(
      `SELECT array_agg(venue_id ORDER BY venue_id) AS ids FROM admin_staff_venues WHERE staff_id = $1`,
      [id]
    );
    const existingVenueIds = (existingVenuesQ.rows[0]?.ids || []).filter(Boolean);
    const venueIdsTouched = !ragicLocked && (Array.isArray(patch.venue_ids) || patch.venue_id !== undefined);
    const newVenueIds = venueIdsTouched
      ? pickVenueIds(patch)
      : (existingVenueIds.length ? existingVenueIds : (cur.rows[0].venue_id ? [cur.rows[0].venue_id] : []));

    const merged = {
      name: (!ragicLocked && patch.name !== undefined) ? String(patch.name).trim() : cur.rows[0].name,
      phone: (!ragicLocked && patch.phone !== undefined) ? String(patch.phone || '').trim() : cur.rows[0].phone,
      role: patch.role ?? cur.rows[0].role,
      venue_id: newVenueIds[0] || null,
      venue_ids: newVenueIds,
      is_senior: patch.is_senior != null ? !!patch.is_senior : !!cur.rows[0].is_senior,
      multiplier: patch.multiplier != null ? Number(patch.multiplier) : Number(cur.rows[0].multiplier),
      active: patch.active != null ? !!patch.active : !!cur.rows[0].active,
    };
    if (!merged.name) return res.status(400).json({ error: '姓名必填' });
    if (merged.role === 'coach' && !merged.phone) {
      return res.status(400).json({ error: '教練角色必須有手機（用於建立教練 LIFF 紀錄）' });
    }

    const activeChanged = patch.active != null && (!!patch.active) !== !!cur.rows[0].active;
    const roleChanged = patch.role != null && patch.role !== cur.rows[0].role;
    const coachProfilePatch = patch.coach_profile || null;

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

    if (venueIdsTouched) {
      await syncStaffVenues(client, id, newVenueIds);
    }

    if (merged.role === 'coach') {
      await ensureCoachRow(client,
        { ...r.rows[0], venue_ids: newVenueIds },
        { is_active: merged.active, coach_profile: coachProfilePatch });
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
      await client.query(
        `UPDATE coaches
            SET is_active = $2, active_overridden_at = NOW(), updated_at = NOW()
          WHERE ragic_employee_id = $1`,
        [id, merged.active]
      );
    }

    // Task #91：非 coach 角色也可由 coach_profile.is_active 翻轉 coach 身分（兼任）
    if (patch.coach_active !== undefined && merged.role !== 'coach') {
      await setCoachProfileActive(client, r.rows[0], patch.coach_active, {
        is_senior: merged.is_senior,
        multiplier: merged.multiplier,
      });
      // 啟用後若還帶了 coach_profile 內容，套用 bio / specialties 等
      if (patch.coach_active && coachProfilePatch) {
        await applyCoachProfilePatch(client, id, coachProfilePatch);
      }
    } else if (merged.role !== 'coach' && coachProfilePatch) {
      // 已有 coach 兼任身分 → 直接套 bio/specialties（不翻 is_active）
      await applyCoachProfilePatch(client, id, coachProfilePatch);
    }
    // Task #91 fix：dual-role 教練（role!='coach' 但 coach row 已存在且啟用）也要同步
    //                is_senior / multiplier 到 coaches，否則 admin 在彈窗改了不會生效。
    if (merged.role !== 'coach' && patch.coach_active === undefined) {
      const cExist = await client.query(
        `SELECT id, is_active FROM coaches WHERE ragic_employee_id = $1`, [id]
      );
      if (cExist.rowCount && cExist.rows[0].is_active &&
          (patch.is_senior !== undefined || patch.multiplier !== undefined)) {
        await client.query(
          `UPDATE coaches
              SET is_senior = $2, pricing_multiplier = $3, updated_at = NOW()
            WHERE ragic_employee_id = $1`,
          [id, merged.is_senior, merged.multiplier]
        );
      }
    }
    // Task #91 fix：介紹圖排序與刪除 — 後台改的順序 / 刪除一起在同一交易內持久化。
    // payload.bio_media: [{ id, sort_order }]，未出現在陣列中的 id 視為刪除。
    if (Array.isArray(patch.bio_media)) {
      const coachRow = await client.query(
        `SELECT id FROM coaches WHERE ragic_employee_id = $1`, [id]
      );
      const coachId = coachRow.rows[0]?.id;
      if (coachId) {
        const keepIds = patch.bio_media.map((m) => m.id).filter(Boolean);
        if (keepIds.length === 0) {
          await client.query(`DELETE FROM coach_bio_media WHERE coach_id = $1`, [coachId]);
        } else {
          await client.query(
            `DELETE FROM coach_bio_media WHERE coach_id = $1 AND id <> ALL($2::uuid[])`,
            [coachId, keepIds]
          );
          for (let i = 0; i < patch.bio_media.length; i++) {
            const m = patch.bio_media[i];
            if (!m?.id) continue;
            await client.query(
              `UPDATE coach_bio_media SET sort_order = $1
                 WHERE id = $2 AND coach_id = $3`,
              [i, m.id, coachId]
            );
          }
        }
      }
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

// 檢視密碼（眼睛）：密碼以 bcrypt 雜湊保存無法還原，但若仍為「預設＝員工編號」即可確認並回傳明碼；
// 員工自行改過後比對失敗 → is_default=false，誠實回報無法顯示。僅 admin 可用。
router.get('/:id/password-hint', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const u = await pool.query(`SELECT password_hash FROM admin_users WHERE staff_id = $1`, [id]);
    if (!u.rowCount || !u.rows[0].password_hash) {
      return res.json({ has_account: false, is_default: false, password: null });
    }
    const isDefault = await bcrypt.compare(String(id), u.rows[0].password_hash);
    res.json({ has_account: true, is_default: isDefault, password: isDefault ? String(id) : null });
  } catch (err) {
    console.error('[admin/staff/:id/password-hint]', err);
    res.status(500).json({ error: '讀取密碼資訊失敗' });
  }
});

module.exports = router;
