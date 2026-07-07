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
const { signToken, requireAdminAuth } = require('../../middlewares/adminAuth');

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

function _loginPayload(u, password, token) {
  const venueIds = Array.isArray(u.venue_ids) ? u.venue_ids.filter(Boolean) : [];
  const primaryVenue = u.venue_id || venueIds[0] || null;
  const staffId = String(u.staff_id || '').trim();
  const staffPhone = String(u.staff_phone || '').trim();
  const defaultUsername = !!staffId && String(u.username || '').trim() === staffId;
  const defaultPassword = !!staffPhone && String(password || '') === staffPhone;
  const mustChangeCredentials = !!staffId && !u.credentials_changed_at && (defaultUsername || defaultPassword);
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
  const venueIds = Array.isArray(u.venue_ids) ? u.venue_ids.filter(Boolean) : [];
  const primaryVenue = u.venue_id || venueIds[0] || null;
  const token = signToken({
    sub: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    venue_id: primaryVenue,       // Task #90：相容欄位（= venue_ids[0]）
    venue_ids: venueIds,          // Task #90：多場館
  });
  await pool.query(`UPDATE admin_users SET updated_at = NOW() WHERE id = $1`, [u.id]);
  return _loginPayload(u, password, token);
}

async function _counterStaffDefaultLogin(username, password) {
  const staffId = String(username || '').trim().toUpperCase();
  const phone = String(password || '').trim();
  if (!staffId || !phone) return null;

  const r = await pool.query(
    `SELECT s.id, s.name, s.phone, s.venue_id, s.active, s.role, s.is_counter,
            u.id AS login_user_id, u.credentials_changed_at,
            COALESCE(
              (SELECT array_agg(sv.venue_id ORDER BY sv.venue_id)
                 FROM admin_staff_venues sv WHERE sv.staff_id = s.id),
              CASE WHEN s.venue_id IS NOT NULL AND s.venue_id <> ''
                   THEN ARRAY[s.venue_id]::text[] ELSE ARRAY[]::text[] END
            ) AS venue_ids
       FROM admin_staff s
       LEFT JOIN admin_users u ON u.staff_id = s.id
      WHERE UPPER(TRIM(s.id)) = $1
        AND TRIM(COALESCE(s.phone, '')) = $2
        AND s.active = TRUE
        AND (s.role = 'staff' OR COALESCE(s.is_counter, FALSE) = TRUE)
      LIMIT 1`,
    [staffId, phone]
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
  const hash = await bcrypt.hash(phone, 10);
  const upsert = await pool.query(
    `INSERT INTO admin_users
       (id, username, password_hash, name, role, venue_id, is_active, staff_id, credentials_changed_at)
     VALUES ($1, $2, $3, $4, 'staff', $5, TRUE, $6, NULL)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       name = EXCLUDED.name,
       role = 'staff',
       venue_id = EXCLUDED.venue_id,
       is_active = TRUE,
       staff_id = EXCLUDED.staff_id,
       credentials_changed_at = NULL,
       updated_at = NOW()
     RETURNING id, username, password_hash, name, role, venue_id, is_active,
               staff_id, $7::text AS staff_phone, NULL::timestamptz AS credentials_changed_at,
               $8::text[] AS venue_ids`,
    [userId, staff.id, hash, staff.name, staff.venue_id || null, staff.id, phone, staff.venue_ids || []]
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
              u.staff_id, s.phone AS staff_phone, u.credentials_changed_at,
              COALESCE(
                (SELECT array_agg(sv.venue_id ORDER BY sv.venue_id)
                   FROM admin_staff_venues sv WHERE sv.staff_id = u.staff_id),
                CASE WHEN u.venue_id IS NOT NULL AND u.venue_id <> ''
                     THEN ARRAY[u.venue_id]::text[] ELSE ARRAY[]::text[] END
              ) AS venue_ids
         FROM admin_users u
         LEFT JOIN admin_staff s ON s.id = u.staff_id
        WHERE u.username = $1`,
      [String(username).trim()]
    );
    const u = r.rows[0];
    if (!u) {
      const staffLogin = await _counterStaffDefaultLogin(username, password);
      if (!staffLogin) return res.json(null);
      return res.json(await _issueLogin(staffLogin, password));
    }
    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) return res.json(null);
    // Task #53：H01 離職同步會把 is_active 設 false → 拒絕登入（密碼正確但禁用）
    if (u.is_active === false) {
      return res.status(403).json({ error: '此帳號已停用，請聯絡系統管理員' });
    }

    res.json(await _issueLogin(u, password));
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
