/**
 * 家長端 LIFF 授權中介層
 * - signParentToken({ parentId, phone, lineUid? }): 簽 12h JWT，payload type='parent'
 * - requireParent: 必須持有有效 JWT 且 type === 'parent'
 *
 * 與 coachAuth 共用 JWT_SECRET（getSecret 邏輯一致）。
 * Phase 4 之前家長端皆走 mock，故 LIFF 直接用 mockDb；Phase 4 後若 VITE_USE_MOCK=false，
 * LIFF 會先呼叫 POST /api/auth/parent-login 取得 token，再用 Bearer 呼叫 /api/chat/*。
 */
const jwt = require('jsonwebtoken');
const { pool } = require('../models/db');

const TTL = '12h';

// 與 adminAuth.getSecret() 共用同一 fallback，避免 admin 簽的 JWT 在 WS 端
// 因 secret 不一致而 verify 失敗。production 一律強制 JWT_SECRET。
const { getSecret: _adminGetSecret } = require('./adminAuth');
function getSecret() { return _adminGetSecret(); }

function signParentToken({ parentId, phone, lineUid = null }) {
  const payload = { parentId, phone, type: 'parent' };
  if (lineUid) payload.lineUid = lineUid;
  return jwt.sign(payload, getSecret(), { expiresIn: TTL });
}

async function requireParent(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let p;
  try {
    p = jwt.verify(token, getSecret());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (p.type !== 'parent') return res.status(403).json({ error: 'Parent token required' });

  // 每次請求都跟資料庫即時比對：帳號被刪除或停用(is_active=FALSE)即失效，前端會收到 401 並登出。
  try {
    const r = await pool.query('SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE', [p.parentId]);
    if (!r.rowCount) return res.status(401).json({ error: 'Parent account not found', code: 'PARENT_NOT_FOUND' });
  } catch (err) {
    console.error('[requireParent] DB check failed:', err.message);
    return res.status(500).json({ error: 'Auth check failed' });
  }

  req.parent = { id: p.parentId, phone: p.phone, lineUid: p.lineUid || null };
  next();
}

// 同時接受 parent / coach token，於 chat HTTP 路由共用
async function requireLiffUser(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let p;
  try {
    p = jwt.verify(token, getSecret());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (p.type === 'parent') {
    // 家長被刪除/停用即失效（與 requireParent 一致）
    try {
      const r = await pool.query('SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE', [p.parentId]);
      if (!r.rowCount) return res.status(401).json({ error: 'Parent account not found', code: 'PARENT_NOT_FOUND' });
    } catch (err) {
      console.error('[requireLiffUser] DB check failed:', err.message);
      return res.status(500).json({ error: 'Auth check failed' });
    }
    req.liffUser = { type: 'parent', id: p.parentId, phone: p.phone };
  } else if (p.type === 'coach') {
    req.liffUser = { type: 'coach', id: p.coachId, phone: p.phone };
  } else {
    return res.status(403).json({ error: 'LIFF token required' });
  }
  next();
}

// 選用：若有合法 parent JWT 就解析到 req.parent，沒有也放行
function optionalParent(req, _res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const p = jwt.verify(token, getSecret());
      if (p.type === 'parent') {
        req.parent = { id: p.parentId, phone: p.phone, lineUid: p.lineUid || null };
      }
    } catch { /* 忽略，視為訪客 */ }
  }
  next();
}

module.exports = { signParentToken, requireParent, requireLiffUser, optionalParent, getSecret };
