/**
 * 認證 Middleware
 * LINE LIFF 端：驗證 JWT（含 line_uid, type: 'parent'|'coach'）
 * 後台端：驗證 JWT（含 staff_id, role: 'system_admin'|'manager'|'counter'）
 */
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// 角色簡寫
const isAdmin   = requireRole('system_admin');
const isManager = requireRole('system_admin', 'manager');
const isCounter = requireRole('system_admin', 'manager', 'counter');
const isLiff    = (req, res, next) => {
  if (!['parent', 'coach'].includes(req.user?.type)) {
    return res.status(403).json({ error: 'LIFF only' });
  }
  next();
};

module.exports = { requireAuth, requireRole, isAdmin, isManager, isCounter, isLiff };
