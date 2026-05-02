/**
 * /api/auth — LIFF 端 token 簽發
 *
 *  POST /api/auth/parent-login   { phone }                  → { id, name, phone, token }
 *      - MVP：以家長手機號為單因素登入（與既有 mock 行為對齊）
 *      - 找不到家長 → 200 + null（與 mock parentByPhone 一致）
 *      - 後續加 LIFF id_token 雙因素時，沿用 services/lineAuth.js 即可
 *
 *  教練端登入沿用 routes/coaches.js: POST /api/coaches/by-phone
 */
const express = require('express');
const { pool } = require('../models/db');
const { signParentToken } = require('../middlewares/parentAuth');

const router = express.Router();

// per-IP 速率限制（與 coach by-phone 同樣 5 / 5min → 429），抑制電話號碼暴搜
const _attempts = new Map(); // ip → [ts...]
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
function _rateLimited(ip) {
  const now = Date.now();
  const arr = (_attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  _attempts.set(ip, arr);
  if (_attempts.size > 5000) _attempts.clear(); // crude GC
  return arr.length > MAX_ATTEMPTS;
}

router.post('/parent-login', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (_rateLimited(ip)) {
      console.warn('[auth/parent-login] rate-limited ip=', ip);
      return res.status(429).json({ error: '嘗試次數過多，請稍後再試' });
    }
    const phone = String(req.body?.phone || '').trim();
    if (!phone) return res.status(400).json({ error: '手機必填' });
    const r = await pool.query(
      `SELECT id, name, phone, line_uid, primary_venue_id FROM parents WHERE phone = $1`,
      [phone]
    );
    if (!r.rowCount) return res.json(null);
    const p = r.rows[0];
    const token = signParentToken({ parentId: p.id, phone: p.phone, lineUid: p.line_uid });
    // students 一併回傳，方便前端 AuthContext 同步
    const s = await pool.query(`SELECT id, name, birth_date FROM students WHERE parent_id = $1`, [p.id]);
    res.json({
      id: p.id, name: p.name, phone: p.phone,
      primary_venue_id: p.primary_venue_id,
      students: s.rows,
      token,
    });
  } catch (err) {
    console.error('[auth/parent-login]', err);
    res.status(500).json({ error: 'login failed' });
  }
});

router.all('*', (req, res) => {
  res.status(404).json({ error: 'auth endpoint not found', path: req.path });
});

module.exports = router;
