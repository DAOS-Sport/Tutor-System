/**
 * 教練端 LIFF 授權中介層
 * - signCoachToken({coachId, phone, lineUid}): 簽發 12 小時 JWT
 * - requireCoach: 必須持有有效 JWT 且 type === 'coach'
 * - requireCoachOwner(paramName): 確認路徑參數所指 coach 與 token 內 coachId 一致 (IDOR 防護)
 * - byPhoneRateLimit: 對 /coaches/by-phone 做 per-IP 速率限制 (防暴力枚舉手機)
 *
 * 認證設計：
 *   - 生產環境 (NODE_ENV=production 或 REQUIRE_LINE_ID_TOKEN=1)：手機 + LIFF id_token 雙因素必填
 *     LINE 驗證見 services/lineAuth.js，比對 coaches.line_uid 後才簽發 token
 *   - 開發環境且未帶 id_token 時：允許 phone-only 後備（並輸出 warn log）
 *   - 速率限制 + 失敗紀錄 console.warn 始終啟用
 *
 * Token payload 結構：{ coachId, phone, lineUid?, type: 'coach', iat, exp }
 */
const jwt = require('jsonwebtoken');

const TOKEN_TTL = '12h';

// 與 adminAuth.getSecret() 共用同一 fallback，確保跨 middleware 的 JWT
// 都用相同 secret 簽發/驗證；production 一律強制 JWT_SECRET。
const { getSecret: _adminGetSecret } = require('./adminAuth');
function getSecret() { return _adminGetSecret(); }

function signCoachToken({ coachId, phone, lineUid = null }) {
  const payload = { coachId, phone, type: 'coach' };
  if (lineUid) payload.lineUid = lineUid;
  return jwt.sign(payload, getSecret(), { expiresIn: TOKEN_TTL });
}

function requireCoach(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, getSecret());
    if (payload.type !== 'coach') return res.status(403).json({ error: 'Coach token required' });
    req.coach = { id: payload.coachId, phone: payload.phone, lineUid: payload.lineUid || null };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireCoachOwner(paramName = 'id') {
  return (req, res, next) => {
    const target = req.params[paramName];
    if (!target) return res.status(400).json({ error: `path param ${paramName} required` });
    if (String(target) !== String(req.coach?.id)) {
      return res.status(403).json({ error: 'Forbidden: cannot access another coach\'s resource' });
    }
    next();
  };
}

/**
 * 簡單的 in-memory rate limit（單機 MVP 夠用；正式部署改 Redis-backed 並搬到 Phase 7）
 * 規則：同一 IP 對任意手機在 5 分鐘內最多 5 次 by-phone 查詢
 */
const ATTEMPTS = new Map(); // key = ip → { count, windowStart }
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function byPhoneRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
  const now = Date.now();
  const rec = ATTEMPTS.get(ip);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    ATTEMPTS.set(ip, { count: 1, windowStart: now });
    return next();
  }
  rec.count += 1;
  if (rec.count > MAX_ATTEMPTS) {
    console.warn(`[coachAuth] rate-limited: ip=${ip} attempts=${rec.count} phone=${req.query?.phone || ''}`);
    return res.status(429).json({ error: 'Too many login attempts. Please retry in 5 minutes.' });
  }
  next();
}

function logFailedLogin(ip, phone, reason) {
  console.warn(`[coachAuth] failed login: ip=${ip} phone=${phone} reason=${reason}`);
}

module.exports = { signCoachToken, requireCoach, requireCoachOwner, byPhoneRateLimit, logFailedLogin };
