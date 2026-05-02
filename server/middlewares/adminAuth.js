/**
 * Admin Phase 3 後台 JWT 驗證 middleware
 * - Token 簽發於 routes/admin/auth.js（POST /api/admin/auth/login）
 * - payload 至少含 { sub, username, name, role: 'admin'|'manager'|'staff', venue_id }
 * - 前端把 token 寫進 localStorage 後，由 client.js interceptor 帶 Authorization: Bearer
 *
 * 安全規則：
 * - JWT_SECRET 為必要 env。production (NODE_ENV=production) 缺少時直接 throw，
 *   server 啟動就會 crash，避免靜默 fallback 到弱 secret 造成 token 偽造。
 * - 非 production 才允許用一個帶警告的開發用 fallback，且每次使用都會 log。
 */
const jwt = require('jsonwebtoken');

const IS_PROD = process.env.NODE_ENV === 'production';
const DEV_FALLBACK_SECRET = '__DEV_ONLY_admin_jwt_fallback__';

let warnedFallback = false;
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (IS_PROD) {
    throw new Error(
      '[adminAuth] JWT_SECRET 未設定（或長度 < 16）。production 環境拒絕使用 fallback secret，' +
      '請在 Replit Secrets 設定 JWT_SECRET 後再啟動。'
    );
  }
  if (!warnedFallback) {
    console.warn('[adminAuth] WARNING: JWT_SECRET 未設定，目前使用開發用 fallback secret（僅限 NODE_ENV != production）。請儘速設定 JWT_SECRET。');
    warnedFallback = true;
  }
  return DEV_FALLBACK_SECRET;
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

function signToken(payload, opts = {}) {
  return jwt.sign(payload, getSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    ...opts,
  });
}

function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    const payload = verifyToken(token);
    if (!['admin', 'manager', 'staff'].includes(payload.role)) {
      return res.status(403).json({ error: 'Not an admin/manager/staff token' });
    }
    req.adminUser = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdminRole(...roles) {
  return (req, res, next) => {
    if (!req.adminUser) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.adminUser.role)) {
      return res.status(403).json({ error: `需要角色：${roles.join('/')}` });
    }
    next();
  };
}

/** 啟動時呼叫；production 缺 JWT_SECRET 直接 throw 讓 process 結束。 */
function assertSecretConfigured() {
  if (IS_PROD) {
    // 直接呼叫一次 getSecret()；若有問題會 throw
    getSecret();
  }
}

module.exports = { signToken, verifyToken, requireAdminAuth, requireAdminRole, assertSecretConfigured };
