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
      `SELECT id, username, password_hash, name, role, venue_id, is_active
         FROM admin_users
        WHERE username = $1`,
      [String(username).trim()]
    );
    const u = r.rows[0];
    if (!u) return res.json(null);
    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) return res.json(null);
    // Task #53：H01 離職同步會把 is_active 設 false → 拒絕登入（密碼正確但禁用）
    if (u.is_active === false) {
      return res.status(403).json({ error: '此帳號已停用，請聯絡系統管理員' });
    }

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
