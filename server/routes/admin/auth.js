/**
 * POST /api/admin/auth/login
 * 對應 client/admin/src/api/mock.js → mockDb.login()
 *
 * 回傳 shape：{ id, username, name, role, venue_id, token, must_change_credentials }
 *  - 帳號密碼錯誤時回 200 + null（與 mock 一致；前端以 falsy 判斷）
 *  - 密碼用 bcrypt 比對，token 為 JWT（payload 含 sub/role/venue_id）
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../../models/db');
const { signToken, requireAdminAuth, BACKOFFICE_ROLES } = require('../../middlewares/adminAuth');
// 身分優先序的唯一來源；登入時用它決定 JWT 上的代表角色。
const { highestRole } = require('../../constants/roles');
const {
  cleanVenueList,
  ADMIN_USER_VENUE_IDS_SELECT,
} = require('../../services/coachVenueScope');

const router = express.Router();

// Task #68：per-IP 登入速率限制（5 次 / 5 分鐘 → 429），與 LIFF 家長 / 教練同策略,
// 抑制弱密碼暴搜（後台帳號名單固定，破解風險高）。
const _attempts = new Map(); // ip → [ts...]
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
function _rateLimited(ip) {
  const now = Date.now();
  const arr = (_attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  _attempts.set(ip, arr);
  if (_attempts.size > 5000) _attempts.clear();
  return arr.length > MAX_ATTEMPTS;
}

const BACKOFFICE_ROLE_SET = new Set(BACKOFFICE_ROLES);
function _backofficeRole(value) {
  const role = String(value || '').trim();
  return BACKOFFICE_ROLE_SET.has(role) ? role : null;
}

/**
 * 一個「代表值」欄位是否能當成真正的身分。
 *
 * admin_staff.role 有 CHECK constraint，一定要有值；純教練落在保底值 'staff'。
 * admin_users.role 同理 —— staff.js:841/:998 把教練的登入帳號也記成 'staff'。
 * 直接採用這兩個欄位，教練登入後就會拿到整套櫃檯權限（客戶資料、對帳、退款），
 * 而且畫面上完全看不出來。
 *
 * 判準與 routes/admin/staff.js 的 rowToStaff 一致（那裡決定徽章要不要顯示
 * 「行政櫃檯」）—— 兩邊各寫一套的話，同一個人在列表上和登入時會被當成不同身分。
 */
function _usableRole(u, value) {
  const role = String(value || '').trim();
  if (!BACKOFFICE_ROLE_SET.has(role)) return null;
  if (role === 'admin' || role === 'manager') return role;
  if (u.is_counter || (!u.is_coach && !u.is_lifeguard)) return role;
  return null;
}

/**
 * 這次登入要用哪一個角色 —— 取這個人所有後台身分裡優先序最高的那一個。
 *
 * 身分有四個來源：
 *   admin_staff_roles        管理員在 F-A02 手動勾選的完整集合（多選身分）
 *   is_counter / is_lifeguard  Ragic 認定的身分（唯讀）
 *   admin_staff.role         代表值，要過 _usableRole
 *   admin_users.role         上次登入算出來的，同樣要過 _usableRole
 *
 * 原本是四段手寫的 if，**完全沒有讀 admin_staff_roles**。後果是「編輯員工」
 * 的多選身分對登入毫無作用：管理員幫一位教練加上救生員身分，存檔成功、
 * 畫面正確、權限聯集也算得到，但那個人登入時看到的是「帳號或密碼錯誤」。
 *
 * 手動勾選的身分不套 _usableRole —— 那是管理員明確指定的，不是推導出來的保底值。
 *
 * 用 highestRole 而不是自己排一套順序：同一套優先序另外還有三個地方在用
 * （F-A02 存檔、Ragic 同步、_counterStaffDefaultLogin）。順帶保住原本那條規則 ——
 * staff 排在 lifeguard 前面，所以「櫃檯兼救生員」仍然是櫃檯，他隔天才打得開對帳單。
 */
function _effectiveLoginUser(u) {
  if (!u) return null;
  const staffId = String(u.staff_id || '').trim();
  if (!staffId) {
    // 沒有連到 admin_staff 的內建系統帳號：只有 admin_users.role 可依據。
    const currentRole = _backofficeRole(u.role);
    return currentRole ? { ...u, role: currentRole } : null;
  }
  const identities = (Array.isArray(u.manual_roles) ? u.manual_roles : [])
    .map((r) => String(r || '').trim());
  if (u.is_counter) identities.push('staff');
  if (u.is_lifeguard) identities.push('lifeguard');
  identities.push(_usableRole(u, u.staff_role));
  identities.push(_usableRole(u, u.role));
  const role = highestRole(identities.filter((r) => BACKOFFICE_ROLE_SET.has(r)));
  return role ? { ...u, role } : null;
}

function _loginPayload(u, password, token) {
  const venueIds = cleanVenueList(u.venue_ids);
  const primaryVenue = venueIds[0] || u.venue_id || null;
  const staffId = String(u.staff_id || '').trim();
  const staffPhone = String(u.staff_phone || '').trim();
  const defaultUsername = !!staffId && String(u.username || '').trim() === staffId;
  const defaultPassword = !!staffPhone && String(password || '') === staffPhone;
  // 預設帳密只提醒，不阻擋登入：前端會跳出可關閉的個人設定視窗。
  const mustChangeCredentials = !!staffId
    && !u.credentials_changed_at && (defaultUsername || defaultPassword);
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    venue_id: primaryVenue,
    venue_ids: venueIds,
    staff_id: staffId || null,
    must_change_credentials: mustChangeCredentials,
    token,
  };
}

async function _issueLogin(u, password) {
  const loginUser = _effectiveLoginUser(u);
  if (!loginUser) return null;
  const venueIds = cleanVenueList(loginUser.venue_ids);
  const primaryVenue = venueIds[0] || loginUser.venue_id || null;
  const token = signToken({
    sub: loginUser.id,
    username: loginUser.username,
    name: loginUser.name,
    role: loginUser.role,
    venue_id: primaryVenue,       // Task #90：相容欄位（= venue_ids[0]）
    venue_ids: venueIds,          // Task #90：多場館
  });
  if (loginUser.role !== u.role) {
    await pool.query(
      `UPDATE admin_users SET role = $2, updated_at = NOW() WHERE id = $1`,
      [loginUser.id, loginUser.role]
    );
  } else {
    await pool.query(`UPDATE admin_users SET updated_at = NOW() WHERE id = $1`, [loginUser.id]);
  }
  return _loginPayload(loginUser, password, token);
}

async function _counterStaffDefaultLogin(username, password) {
  const staffId = String(username || '').trim().toUpperCase();
  const phone = String(password || '').trim();
  if (!staffId || !phone) return null;

  const r = await pool.query(
    `SELECT s.id, s.name, s.phone, s.venue_id, s.active, s.role,
            s.is_counter, s.is_coach, s.is_lifeguard,
            COALESCE(ARRAY(SELECT r.role FROM admin_staff_roles r
                            WHERE r.staff_id = s.id), '{}') AS manual_roles,
            u.id AS login_user_id, u.role AS user_role, u.credentials_changed_at,
            ${ADMIN_USER_VENUE_IDS_SELECT} AS venue_ids
       FROM admin_staff s
       LEFT JOIN admin_users u ON u.staff_id = s.id
      WHERE UPPER(TRIM(s.id)) = $1
        AND TRIM(COALESCE(s.phone, '')) = $2
        AND s.active = TRUE
        AND (
          s.role IN ('admin', 'manager')
          OR u.role IN ('admin', 'manager')
          OR COALESCE(s.is_counter, FALSE) = TRUE
          -- 救生員與櫃檯用同一個後台入口。原本這裡明文排除他們
          -- （... AND is_lifeguard = FALSE），因為當年沒有 lifeguard 這個角色值，
          -- 放進來只會被算成「行政櫃檯」而拿到整套櫃檯權限。
          -- 現在角色分得開、頁面權限也由 F-A06 控制，才解除。
          OR COALESCE(s.is_lifeguard, FALSE) = TRUE
          -- 管理員在 F-A02 手動勾的後台身分也算數。少了這一條，
          -- 「教練兼救生員」存得進去、權限算得到，但登入時被這個 WHERE 濾掉。
          OR EXISTS (SELECT 1 FROM admin_staff_roles r
                      WHERE r.staff_id = s.id
                        AND r.role = ANY ($3::text[]))
          OR (s.role = 'staff'
              AND COALESCE(s.is_coach, FALSE) = FALSE
              AND COALESCE(s.is_lifeguard, FALSE) = FALSE)
        )
      LIMIT 1`,
    [staffId, phone, [...BACKOFFICE_ROLES]]
  );
  const staff = r.rows[0];
  if (!staff) return null;
  if (staff.login_user_id && staff.credentials_changed_at) return null;

  const dup = await pool.query(
    `SELECT 1 FROM admin_users WHERE username = $1 AND staff_id IS DISTINCT FROM $2 LIMIT 1`,
    [staff.id, staff.id]
  );
  if (dup.rowCount) {
    const err = new Error(`員工編號 ${staff.id} 已被其他登入帳號使用`);
    err.statusCode = 409;
    throw err;
  }

  const userId = staff.login_user_id || `U_${staff.id}`;
  // 取這個人所有後台身分裡優先序最高的那一個。
  //
  // 原本是「不是 admin 也不是 manager 就一律 staff」。開放救生員登入之後，
  // 那一行會直接把 52 位救生員變成行政櫃檯 —— 拿到客戶資料、對帳、退款的
  // 全部權限，而且畫面上完全看不出來。這是這次改動最危險的一處。
  const identities = (Array.isArray(staff.manual_roles) ? staff.manual_roles : [])
    .map((r) => String(r || '').trim());
  if (staff.is_counter) identities.push('staff');
  if (staff.is_lifeguard) identities.push('lifeguard');
  identities.push(_usableRole(staff, staff.role));
  identities.push(_usableRole(staff, staff.user_role));
  const loginRole = highestRole(identities.filter((r) => BACKOFFICE_ROLES.includes(r))) || 'staff';
  const hash = await bcrypt.hash(phone, 10);
  const upsert = await pool.query(
    `INSERT INTO admin_users
       (id, username, password_hash, name, role, venue_id, is_active, staff_id, credentials_changed_at)
     VALUES ($1, $2, $3, $4, $7, $5, TRUE, $6, NULL)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       name = EXCLUDED.name,
       role = EXCLUDED.role,
       venue_id = EXCLUDED.venue_id,
       is_active = TRUE,
       staff_id = EXCLUDED.staff_id,
       credentials_changed_at = NULL,
       updated_at = NOW()
     RETURNING id, username, password_hash, name, role, venue_id, is_active,
               staff_id, $8::text AS staff_phone, NULL::timestamptz AS credentials_changed_at,
               $9::text[] AS venue_ids, $10::text AS staff_role,
               $11::boolean AS is_counter, $12::boolean AS is_coach, $13::boolean AS is_lifeguard,
               $14::text[] AS manual_roles`,
    [
      userId, staff.id, hash, staff.name, staff.venue_id || null, staff.id, loginRole,
      phone, cleanVenueList(staff.venue_ids), staff.role,
      !!staff.is_counter, !!staff.is_coach, !!staff.is_lifeguard,
      Array.isArray(staff.manual_roles) ? staff.manual_roles : [],
    ]
  );
  return upsert.rows[0] || null;
}

router.post('/login', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (_rateLimited(ip)) {
      console.warn('[admin/auth/login] rate-limited ip=', ip);
      return res.status(429).json({ error: '嘗試次數過多，請稍後再試' });
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '請提供帳號密碼' });
    }
    const r = await pool.query(
      `SELECT u.id, u.username, u.password_hash, u.name, u.role, u.venue_id, u.is_active,
              u.staff_id, s.phone AS staff_phone, s.role AS staff_role,
              s.is_counter, s.is_coach, s.is_lifeguard, u.credentials_changed_at,
              -- 手動指派的身分。沒有這個，F-A02 的多選身分對登入完全無效。
              COALESCE(ARRAY(SELECT r.role FROM admin_staff_roles r
                              WHERE r.staff_id = s.id), '{}') AS manual_roles,
              ${ADMIN_USER_VENUE_IDS_SELECT} AS venue_ids
         FROM admin_users u
         LEFT JOIN admin_staff s ON s.id = u.staff_id
        WHERE u.username = $1`,
      [String(username).trim()]
    );
    const u = r.rows[0];
    if (!u) {
      const staffLogin = await _counterStaffDefaultLogin(username, password);
      if (!staffLogin) return res.json(null);
      const payload = await _issueLogin(staffLogin, password);
      if (!payload) return res.json(null);
      return res.json(payload);
    }
    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) return res.json(null);
    // Task #53：H01 離職同步會把 is_active 設 false → 拒絕登入（密碼正確但禁用）
    if (u.is_active === false) {
      return res.status(403).json({ error: '此帳號已停用，請聯絡系統管理員' });
    }

    const payload = await _issueLogin(u, password);
    if (!payload) return res.json(null);
    res.json(payload);
  } catch (err) {
    console.error('[admin/auth/login]', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'login failed' });
  }
});

function _normalizeUsername(value) {
  return String(value || '').trim();
}

function _validUsername(value) {
  return /^[A-Za-z0-9._@-]{2,40}$/.test(value);
}

// Task #82：自己改帳號 / 密碼（三角色皆可），不做強度檢查只防呆長度 ≥ 4
router.post('/change-password', requireAdminAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    const newUsername = _normalizeUsername(req.body?.newUsername);
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '請輸入舊密碼與新密碼' });
    }
    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: '新密碼長度需至少 4 個字元' });
    }
    if (String(oldPassword) === String(newPassword)) {
      return res.status(400).json({ error: '新密碼不可與舊密碼相同' });
    }
    const userId = req.adminUser.sub;
    const r = await pool.query(
      `SELECT id, username, password_hash FROM admin_users WHERE id = $1`,
      [userId]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: '找不到帳號' });
    const ok = await bcrypt.compare(String(oldPassword), u.password_hash);
    if (!ok) return res.status(400).json({ error: '舊密碼不正確' });
    if (newUsername) {
      if (!_validUsername(newUsername)) {
        return res.status(400).json({ error: '新帳號需為 2–40 碼，可使用英文、數字、._@-' });
      }
      const dup = await pool.query(
        `SELECT 1 FROM admin_users WHERE username = $1 AND id <> $2 LIMIT 1`,
        [newUsername, u.id]
      );
      if (dup.rowCount) return res.status(409).json({ error: '此帳號已被使用' });
    }
    const newHash = await bcrypt.hash(String(newPassword), 10);
    await pool.query(
      `UPDATE admin_users
          SET username = COALESCE(NULLIF($2, ''), username),
              password_hash = $3,
              credentials_changed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [u.id, newUsername, newHash]
    );
    res.json({ ok: true, username: newUsername || u.username, must_change_credentials: false });
  } catch (err) {
    console.error('[admin/auth/change-password]', err);
    res.status(500).json({ error: '修改密碼失敗' });
  }
});

module.exports = router;
// 供測試直接呼叫。這段邏輯決定「誰進得來、進來是什麼身分」，
// 用讀原始碼比對字串的方式驗很脆弱 —— 換個寫法測試就紅，而真的算錯時
// 反而可能照樣綠。tests/lifeguard_login_test.js 直接餵身分組合驗結果。
module.exports._effectiveLoginUser = _effectiveLoginUser;
