/**
 * POST /api/admin/auth/login
 * 對應 client/admin/src/api/mock.js → mockDb.login()
 *
 * Task #51（employees 表合併）後：
 *  - 改 SELECT FROM employees WHERE email = $1（admin/manager/staff 三個 seed 帳號的「username」放在 email 欄）
 *  - 帳號至少要含 system_admin / manager / counter 其中一個 role 才能登入後台（純 coach 拒絕）
 *  - 簽出的 JWT 同時帶 roles[]（新格式 source of truth）與 role（舊格式 backward-compat shim）
 *    讓散布在 admin route 的 `req.adminUser.role === 'admin'/'manager'/'staff'` 寫法繼續可用
 *  - 回應 body 也同時帶 roles[] + role，client AuthContext 4-6 步會改用 roles[]
 *  - 改 UPDATE employees SET last_login_at = NOW()（取代 admin_users.updated_at）
 *
 * 回傳 shape：{ id, username, name, roles, role, venue_id, token } 或 null
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../../models/db');
const {
  signToken,
  ADMIN_LIKE_ROLES,
  deriveLegacyRole,
} = require('../../middlewares/adminAuth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '請提供帳號密碼' });
    }
    const r = await pool.query(
      `SELECT id, email, password_hash, name, roles, venue_id
         FROM employees
        WHERE email = $1
          AND roles && $2::text[]
          AND is_active = TRUE
        LIMIT 1`,
      [String(username).trim(), ADMIN_LIKE_ROLES]
    );
    const u = r.rows[0];
    if (!u) {
      console.warn('[admin/auth/login] user not found or not admin-like:', String(username).trim());
      return res.json(null);
    }
    if (!u.password_hash) {
      console.warn('[admin/auth/login] employee has no password_hash:', u.email);
      return res.json(null);
    }
    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) {
      console.warn('[admin/auth/login] password mismatch for:', u.email, 'hash_prefix:', u.password_hash.slice(0, 20));
      return res.json(null);
    }

    const roles = (u.roles || []).filter((x) => typeof x === 'string');
    const legacyRole = deriveLegacyRole(roles);

    const token = signToken({
      sub: u.id,
      username: u.email,                  // backward-compat：舊 payload key 名為 username
      name: u.name,
      roles,                              // 新：source of truth
      role: legacyRole,                   // 舊：shim，便於既有 route 過渡
      venue_id: u.venue_id,
    });

    await pool.query(
      `UPDATE employees SET last_login_at = NOW() WHERE id = $1`,
      [u.id]
    );

    res.json({
      id: u.id,
      username: u.email,
      name: u.name,
      roles,
      role: legacyRole,
      venue_id: u.venue_id,
      token,
    });
  } catch (err) {
    console.error('[admin/auth/login]', err);
    res.status(500).json({ error: 'login failed' });
  }
});

module.exports = router;
