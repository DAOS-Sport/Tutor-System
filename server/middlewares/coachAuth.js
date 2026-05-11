/**
 * 教練端 LIFF 授權中介層
 *
 * Task #51 employees 表合併後：
 * - 「coach」現在是 employees 表中 roles 陣列含 'coach' 的 employee
 * - JWT payload 主鍵欄位名 coachId → employeeId（仍指向 employees.id UUID）
 * - 新舊 token 並存期間（最多 12 小時）：requireCoach 同時接受 payload.employeeId 與 payload.coachId
 *
 * 對外 API：
 * - signCoachToken({employeeId, phone, lineUid?, roles?}): 簽發 12 小時 JWT
 *   （亦接受 legacy `coachId` 入參，方便 step 4 還沒改完的呼叫端短期相容）
 * - requireCoach: 必須持有有效 JWT 且 type === 'coach'，將身分注入 req.coach
 *   - req.coach = { id, phone, lineUid, roles[] }
 *   - req.coach.id = employees.id (UUID)
 * - requireCoachOwner(paramName): IDOR 防護，比對 req.params[paramName] === req.coach.id
 * - byPhoneRateLimit / byLineUidRateLimit: per-IP 速率限制（防暴力枚舉）
 *
 * 認證設計（不變）：
 *   - 生產環境 (NODE_ENV=production 或 REQUIRE_LINE_ID_TOKEN=1)：手機 + LIFF id_token 雙因素必填
 *     LINE 驗證見 services/lineAuth.js，比對 employees.line_uid 後才簽發 token
 *   - 開發環境且未帶 id_token 時：允許 phone-only 後備（並輸出 warn log）
 *   - 速率限制 + 失敗紀錄 console.warn 始終啟用
 *
 * Token payload 結構：{ employeeId, phone, type: 'coach', lineUid?, roles?, iat, exp }
 */
const jwt = require('jsonwebtoken');

const TOKEN_TTL = '12h';

// 與 adminAuth.getSecret() 共用同一 fallback，確保跨 middleware 的 JWT
// 都用相同 secret 簽發/驗證；production 一律強制 JWT_SECRET。
const { getSecret: _adminGetSecret } = require('./adminAuth');
function getSecret() { return _adminGetSecret(); }

/**
 * 簽發教練 JWT。
 * @param {Object} args
 * @param {string} [args.employeeId] - 新欄位（推薦）；employees.id UUID
 * @param {string} [args.coachId]    - Legacy 欄位（短期相容；step 4 後移除）
 * @param {string} args.phone
 * @param {string|null} [args.lineUid]
 * @param {string[]} [args.roles] - employees.roles 快照（可選；幫助前端做角色 UI）
 */
function signCoachToken({ employeeId, coachId, phone, lineUid = null, roles = null }) {
  const id = employeeId || coachId;
  if (!id) throw new Error('signCoachToken: employeeId is required');
  const payload = { employeeId: id, phone, type: 'coach' };
  if (lineUid) payload.lineUid = lineUid;
  if (Array.isArray(roles) && roles.length) payload.roles = roles;
  return jwt.sign(payload, getSecret(), { expiresIn: TOKEN_TTL });
}

function requireCoach(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, getSecret());
    if (payload.type !== 'coach') return res.status(403).json({ error: 'Coach token required' });
    // 同時接受新欄位 employeeId 與 legacy coachId（in-flight tokens ≤12h）
    const id = payload.employeeId || payload.coachId;
    if (!id) return res.status(401).json({ error: 'Malformed coach token (missing employeeId)' });
    req.coach = {
      id,
      phone: payload.phone,
      lineUid: payload.lineUid || null,
      roles: Array.isArray(payload.roles) ? payload.roles : ['coach'],
    };
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

/**
 * by-line-uid 速率限制（Task #34）：與 by-phone 共用視窗/上限參數，但獨立計數
 * （避免一次自動登入失敗就把同 IP 的手機 fallback 也鎖掉）
 */
const LINE_UID_ATTEMPTS = new Map();
function byLineUidRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
  const now = Date.now();
  const rec = LINE_UID_ATTEMPTS.get(ip);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    LINE_UID_ATTEMPTS.set(ip, { count: 1, windowStart: now });
    return next();
  }
  rec.count += 1;
  if (rec.count > MAX_ATTEMPTS) {
    console.warn(`[coachAuth] rate-limited by-line-uid: ip=${ip} attempts=${rec.count}`);
    return res.status(429).json({ error: 'Too many login attempts. Please retry in 5 minutes.' });
  }
  next();
}

function logFailedLogin(ip, phone, reason) {
  console.warn(`[coachAuth] failed login: ip=${ip} phone=${phone} reason=${reason}`);
}

module.exports = {
  signCoachToken, requireCoach, requireCoachOwner,
  byPhoneRateLimit, byLineUidRateLimit, logFailedLogin,
};
