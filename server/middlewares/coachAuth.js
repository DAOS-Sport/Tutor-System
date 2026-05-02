/**
 * 教練端 LIFF 授權中介層
 * - signCoachToken({coachId, phone}): 簽發 12 小時 JWT (短 TTL，配合家長 by-phone 驗證 MVP)
 * - requireCoach: 必須持有有效 JWT 且 type === 'coach'
 * - requireCoachOwner(paramName): 確認路徑參數所指 coach 與 token 內 coachId 一致 (IDOR 防護)
 * - byPhoneRateLimit: 對 /coaches/by-phone 做 per-IP+phone 速率限制 (防暴力枚舉手機)
 *
 * ⚠ 已知限制（追蹤於 follow-up task #23）：
 *   目前 token 簽發僅基於手機驗證（與家長端 MVP 相同），尚未驗證 LINE id_token / line_uid 綁定。
 *   正式版本應改為「LIFF 取 id_token → 後端驗證 audience+issuer → 對 coaches.line_uid 比對 → 才簽發 token」。
 *   本檔暫採取的緩解措施：(1) 短 TTL 12h；(2) by-phone rate limit；(3) 失敗嘗試 console.warn 紀錄。
 *
 * Token payload 結構：{ coachId, phone, type: 'coach', iat, exp }
 */
const jwt = require('jsonwebtoken');

const TOKEN_TTL = '12h';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[coachAuth] JWT_SECRET 未設定（production 強制）');
    }
    return 'dev-only-fallback-secret-please-set-real-jwt-secret';
  }
  return s;
}

function signCoachToken({ coachId, phone }) {
  return jwt.sign({ coachId, phone, type: 'coach' }, getSecret(), { expiresIn: TOKEN_TTL });
}

function requireCoach(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, getSecret());
    if (payload.type !== 'coach') return res.status(403).json({ error: 'Coach token required' });
    req.coach = { id: payload.coachId, phone: payload.phone };
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
