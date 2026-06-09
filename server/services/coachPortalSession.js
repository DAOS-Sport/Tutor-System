/**
 * 教練 portal session（DB 持久化 token，預設 30 天）
 * 模板移植：server/shared/auth/coachPortalSession.ts → 改寫為本系統 JS + 原生 pg。
 *
 * 與既有 coachAuth.js（12h 無狀態 JWT）併存：
 *   - OAuth 登入成功後，除了簽既有 12h coach JWT（讓現有 /api/coaches/* requireCoach 不用改），
 *     另存一筆 30 天 portal session → 供「重開 App / server 重啟不需重走 LINE 授權」。
 *   - 前端把 portal token 存 localStorage；coach JWT 過期時用 GET /api/coach-portal/session 換新 JWT。
 *
 * token 讀取優先序：x-coach-token header > ?coachToken= query。
 */
const crypto = require('crypto');
const { pool } = require('../models/db');

const TTL_DAYS = Number(process.env.COACH_PORTAL_SESSION_TTL_DAYS) || 30;

async function issue(coachId, lineUid) {
  const token = crypto.randomBytes(48).toString('base64url');
  await pool.query(
    `INSERT INTO coach_portal_sessions (token, coach_id, line_uid, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval)`,
    [token, coachId, lineUid, String(TTL_DAYS)]
  );
  return token;
}

function readToken(req) {
  const h = req.headers['x-coach-token'];
  if (h) return String(h).trim();
  if (req.query && req.query.coachToken) return String(req.query.coachToken).trim();
  return null;
}

async function verify(token) {
  if (!token) return null;
  const r = await pool.query(
    `SELECT coach_id, line_uid, expires_at
       FROM coach_portal_sessions
      WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  return r.rows[0] || null;
}

async function revoke(token) {
  if (!token) return;
  await pool.query(`DELETE FROM coach_portal_sessions WHERE token = $1`, [token]);
}

// 機會性清理過期 session（不需專門 cron；登入時順手清，best-effort）
async function cleanupExpired() {
  try {
    await pool.query(`DELETE FROM coach_portal_sessions WHERE expires_at < NOW()`);
  } catch (e) {
    /* best-effort，忽略 */
  }
}

module.exports = { issue, readToken, verify, revoke, cleanupExpired, TTL_DAYS };
