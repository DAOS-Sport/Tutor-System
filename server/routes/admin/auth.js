/**
 * POST /api/admin/auth/login
 * 對應 client/admin/src/api/mock.js → mockDb.login()
 *
 * 回傳 shape：{ id, username, name, role, venue_id, token }
 *  - 帳號密碼錯誤時回 200 + null（與 mock 一致；前端以 falsy 判斷）
 *  - 密碼用 bcrypt 比對，token 為 JWT（payload 含 sub/role/venue_id）
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../../models/db');
const { signToken } = require('../../middlewares/adminAuth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '請提供帳號密碼' });
    }
    const r = await pool.query(
      `SELECT id, username, password_hash, name, role, venue_id
         FROM admin_users
        WHERE username = $1`,
      [String(username).trim()]
    );
    const u = r.rows[0];
    if (!u) return res.json(null);
    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) return res.json(null);

    const token = signToken({
      sub: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      venue_id: u.venue_id,
    });

    await pool.query(`UPDATE admin_users SET updated_at = NOW() WHERE id = $1`, [u.id]);

    res.json({
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      venue_id: u.venue_id,
      token,
    });
  } catch (err) {
    console.error('[admin/auth/login]', err);
    res.status(500).json({ error: 'login failed' });
  }
});

module.exports = router;
