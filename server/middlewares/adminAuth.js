/**
 * Admin Phase 3 後台 JWT 驗證 middleware
 *
 * Task #51 employees 表合併後：
 * - JWT payload 的「角色」改採 employees.roles 形式：陣列，元素來自
 *   ['system_admin','manager','counter','coach']
 * - 後台 token 至少需含 system_admin / manager / counter 其中之一（純 coach 不能登後台）
 * - 散布在 admin route 的 `req.adminUser.role === 'admin'/'manager'/'staff'` 寫法
 *   透過 backward-compat shim 仍可運作（role 由 roles 推導）
 *
 * Token payload 結構：
 *   新 (推薦)：{ sub, username, name, roles: ['system_admin'|'manager'|'counter', ...], venue_id }
 *   舊 (in-flight ≤ JWT_EXPIRES_IN，預設 7 天)：{ sub, username, name, role: 'admin'|'manager'|'staff', venue_id }
 *
 * req.adminUser 注入欄位：
 *   - sub / username / name / venue_id：從 payload 直接帶
 *   - roles: string[] — 新格式（source of truth；舊 token 會 normalize 成此格式）
 *   - role:  string  — 舊格式 shim（'admin'/'manager'/'staff'），由 roles 推導，供舊 route 用
 *
 * 安全規則：
 * - JWT_SECRET 為必要 env。production (NODE_ENV=production) 缺少時直接 throw，
 *   server 啟動就會 crash，避免靜默 fallback 到弱 secret 造成 token 偽造。
 * - 非 production 才允許用一個帶警告的開發用 fallback，且每次使用都會 log。
 */
const jwt = require('jsonwebtoken');

const IS_PROD = process.env.NODE_ENV === 'production';
const DEV_FALLBACK_SECRET = '__DEV_ONLY_admin_jwt_fallback__';

// employee role ↔ legacy admin role 對應
const EMPLOYEE_ROLES = ['system_admin', 'manager', 'counter', 'coach'];
const ADMIN_LIKE_ROLES = ['system_admin', 'manager', 'counter'];
// 舊 → 新（payload.role 字串對應）
const LEGACY_TO_EMPLOYEE = { admin: 'system_admin', manager: 'manager', staff: 'counter' };
// 新 → 舊（req.adminUser.role 推導用；取「最高權限」）
function deriveLegacyRole(roles) {
  if (roles.includes('system_admin')) return 'admin';
  if (roles.includes('manager'))      return 'manager';
  if (roles.includes('counter'))      return 'staff';
  return null;
}
// requireAdminRole 入參 normalize（舊名 → 新名；其他保持不變）
const ROLE_ALIAS = { admin: 'system_admin', staff: 'counter' };

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

/**
 * 把 payload 中的角色資訊正規化為 string[]（employee role 名稱）
 * - 新 payload：直接過濾 payload.roles
 * - 舊 payload：把 payload.role (admin/manager/staff) 對應成 employee role
 */
function normalizePayloadRoles(payload) {
  if (Array.isArray(payload.roles)) {
    return payload.roles.filter((r) => EMPLOYEE_ROLES.includes(r));
  }
  if (payload.role && LEGACY_TO_EMPLOYEE[payload.role]) {
    return [LEGACY_TO_EMPLOYEE[payload.role]];
  }
  return [];
}

function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    const payload = verifyToken(token);
    const roles = normalizePayloadRoles(payload);
    if (!roles.some((r) => ADMIN_LIKE_ROLES.includes(r))) {
      return res.status(403).json({ error: 'Not an admin/manager/counter token' });
    }
    req.adminUser = {
      ...payload,
      roles,                            // 新：source of truth
      role: deriveLegacyRole(roles),    // 舊：backward-compat shim
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * requireAdminRole(...names)：name 可用新 (system_admin/counter) 或舊 (admin/staff) 名稱；
 * 'manager' 兩端共用。內部 normalize 後與 req.adminUser.roles 陣列做交集。
 */
function requireAdminRole(...required) {
  const normalized = required.map((r) => ROLE_ALIAS[r] || r);
  return (req, res, next) => {
    if (!req.adminUser) return res.status(401).json({ error: 'Unauthenticated' });
    const roles = req.adminUser.roles || [];
    if (!roles.some((r) => normalized.includes(r))) {
      return res.status(403).json({ error: `需要角色：${required.join('/')}` });
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

module.exports = {
  signToken, verifyToken,
  requireAdminAuth, requireAdminRole,
  assertSecretConfigured, getSecret,
  // 供步驟 4 在 routes/admin/auth.js / AuthContext 複用的 helper
  deriveLegacyRole, normalizePayloadRoles,
  EMPLOYEE_ROLES, ADMIN_LIKE_ROLES, LEGACY_TO_EMPLOYEE,
};
