/**
 * 通用 Auth Middleware
 *
 * Task #51 employees 表合併後：
 * - 角色採 employees.roles 陣列形式：['system_admin','manager','counter','coach']
 *   （取代原本的 'admin'/'manager'/'staff' 字串）
 * - 本檔提供「角色判斷」工具，給未來新加的路由統一使用；adminAuth.js 與 coachAuth.js
 *   仍是各自前後台的 JWT 驗證主入口（本檔 requireAuth 是通用版本）
 *
 * Token 兼容：
 * - 新 payload 含 `roles: string[]`（推薦）
 * - 舊 admin payload 含 `role: 'admin'|'manager'|'staff'`（自動 normalize 成 roles）
 * - 舊 coach payload 含 `coachId`（自動視為 roles=['coach']）
 *
 * req.user 注入欄位：
 *   - 來自 JWT payload 的所有欄位（sub / employeeId / type / venue_id ...）
 *   - roles: string[] — 正規化後的 employee role 名稱
 */
const jwt = require('jsonwebtoken');
const { getSecret, normalizePayloadRoles } = require('./adminAuth');

// 統一的 role 別名（舊 → 新）
const ROLE_ALIAS = { admin: 'system_admin', staff: 'counter' };

/**
 * 從任意 payload 推導出 employee role 陣列。
 * 1. payload.roles 直接拿（並過濾合法值）
 * 2. payload.role 字串 → 對應到 employee role
 * 3. payload.type === 'coach' → ['coach']
 */
function rolesFromPayload(payload) {
  const roles = normalizePayloadRoles(payload);
  if (roles.length) return roles;
  if (payload.type === 'coach') return ['coach'];
  return [];
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, getSecret());
    req.user = { ...payload, roles: rolesFromPayload(payload) };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * hasRole(req, roleName)：roleName 可用新 (system_admin/counter/coach) 或舊 (admin/staff) 名稱。
 */
function hasRole(req, roleName) {
  const roles = req.user?.roles || [];
  const normalized = ROLE_ALIAS[roleName] || roleName;
  return roles.includes(normalized);
}

/**
 * requireRole(...names)：name 可用新或舊角色名（自動 alias）。
 * - 任一角色命中即放行；空陣列視為「不限角色，但需登入」。
 */
function requireRole(...names) {
  const normalized = names.map((n) => ROLE_ALIAS[n] || n);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    const roles = req.user?.roles || [];
    if (normalized.length && !roles.some((r) => normalized.includes(r))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// ─── 角色簡寫（employee 名稱）────────────────────────────────────────
const isSystemAdmin = requireRole('system_admin');
const isManager     = requireRole('system_admin', 'manager');
const isCounter     = requireRole('system_admin', 'manager', 'counter');
const isCoach       = requireRole('coach');

// ─── 後向相容的別名（舊代碼引用）──────────────────────────────────
// 注意：'admin' 舊指 system_admin（不是「任何後台角色」）；isLiff 仍用 type 區分
const isAdmin = isSystemAdmin;
const isLiff = (req, res, next) => {
  if (!['parent', 'coach'].includes(req.user?.type)) {
    return res.status(403).json({ error: 'LIFF only' });
  }
  next();
};

module.exports = {
  requireAuth, requireRole, hasRole, rolesFromPayload,
  // 角色簡寫（employee 名稱推薦使用）
  isSystemAdmin, isManager, isCounter, isCoach,
  // backward-compat 別名
  isAdmin, isLiff,
};
