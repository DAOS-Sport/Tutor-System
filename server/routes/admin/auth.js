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
              u.staff_id,
              COALESCE(
                (SELECT array_agg(sv.venue_id ORDER BY sv.venue_id)
                   FROM admin_staff_venues sv WHERE sv.staff_id = u.staff_id),
                CASE WHEN u.venue_id IS NOT NULL AND u.venue_id <> ''
                     THEN ARRAY[u.venue_id]::text[] ELSE ARRAY[]::text[] END
              ) AS venue_ids
         FROM admin_users u
        WHERE u.username = $1`,
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

    res.json({
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      venue_id: primaryVenue,
      venue_ids: venueIds,
      token,
    });
  } catch (err) {
    console.error('[admin/auth/login]', err);
    res.status(500).json({ error: 'login failed' });
  }
});

// Task #82：自己改密碼（三角色皆可），不做強度檢查只防呆長度 ≥ 4
router.post('/change-password', requireAdminAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
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
      `SELECT id, password_hash FROM admin_users WHERE id = $1`,
      [userId]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: '找不到帳號' });
    const ok = await bcrypt.compare(String(oldPassword), u.password_hash);
    if (!ok) return res.status(400).json({ error: '舊密碼不正確' });
    const newHash = await bcrypt.hash(String(newPassword), 10);
    await pool.query(
      `UPDATE admin_users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
      [u.id, newHash]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/auth/change-password]', err);
    res.status(500).json({ error: '修改密碼失敗' });
  }
});

module.exports = router;
