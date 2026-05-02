/**
 * 教練端 LIFF 授權中介層
 * - requireCoach: 必須持有有效 JWT 且 type === 'coach'
 * - requireCoachOwner(paramName): 確認路徑參數所指 coach 與 token 內 coachId 一致 (IDOR 防護)
 *
 * Token payload 結構：{ coachId, phone, type: 'coach', iat, exp }
 */
const jwt = require('jsonwebtoken');

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
  return jwt.sign({ coachId, phone, type: 'coach' }, getSecret(), { expiresIn: '30d' });
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

/**
 * 確認路徑參數的 coachId 必須等於 token 中的 coachId
 * 用法：router.get('/:coachId/...', requireCoach, requireCoachOwner('coachId'), ...)
 */
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

module.exports = { signCoachToken, requireCoach, requireCoachOwner };
