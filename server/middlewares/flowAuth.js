/**
 * 家長端 LIFF 封閉狀態機專用「flowToken」中介層（修改 PROMPT §3.2）
 * - signFlowToken({ lineUid, phone?, attempts? }): 簽 10 分鐘短效 JWT，payload type='flow'。
 * - requireFlowToken: 必須持有有效 flowToken 且 type==='flow'；僅供 verify-phone /
 *   verify-student / bind / register 四端點掛載。其餘路由一律要求 requireParent
 *   （type==='parent'），flowToken 打上去會被 type 檢查天然拒絕（401，見 parentAuth.js
 *   requireParent），不需要另外維護一份白名單。
 * - 單一流程：token 綁定 lineUid，每步驗證都比對 payload.lineUid 與本次呼叫端驗證出
 *   的 lineUid 是否一致，防止用別人流程中途取得的 flowToken 接續自己的操作。
 * - attempts：STUDENT_VERIFY 3 次重試計數器，內嵌在 token 裡（每次失敗重新簽發遞增，
 *   無需伺服器端額外儲存狀態，重啟/多實例皆不受影響）。
 *
 * 與 parentAuth/coachAuth 共用 JWT_SECRET（getSecret 邏輯一致）。
 */
const jwt = require('jsonwebtoken');
const { getSecret: _adminGetSecret } = require('./adminAuth');
function getSecret() { return _adminGetSecret(); }

const FLOW_TTL_SECONDS = 10 * 60; // 修改 PROMPT §1：短效 10 分鐘

function signFlowToken({ lineUid, phone = null, attempts = 0 }) {
  const uid = String(lineUid || '').trim();
  if (!uid) throw new Error('signFlowToken: lineUid 必填');
  return jwt.sign(
    { type: 'flow', lineUid: uid, phone: phone || null, attempts: Number(attempts) || 0 },
    getSecret(),
    { expiresIn: FLOW_TTL_SECONDS }
  );
}

function requireFlowToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized', code: 'FLOW_TOKEN_REQUIRED' });
  let payload;
  try {
    payload = jwt.verify(token, getSecret());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired flow token', code: 'FLOW_TOKEN_INVALID' });
  }
  if (payload.type !== 'flow') {
    return res.status(403).json({ error: 'Flow token required', code: 'FLOW_TOKEN_REQUIRED' });
  }
  req.flow = {
    lineUid: payload.lineUid,
    phone: payload.phone || null,
    attempts: Number(payload.attempts) || 0,
  };
  next();
}

/**
 * 簡單 in-process rate limit（比照 coachAuth.js byPhoneRateLimit 既有寫法：單機 MVP
 * 夠用，正式部署改 Redis-backed；規則同款 5 分鐘 5 次）。verify-phone 用來防列舉。
 *
 * 修改 PROMPT §3.5：鍵值須「UID+IP」而非只看 IP——單看 IP 對共用出口 IP（校園/
 * 公司網路）的正常使用者太容易誤傷，單看 UID 則擋不住同一支手機動態換 IP 硬灌。
 * 必須掛在 requireFlowToken 之後（見 auth.js 路由掛載順序），才能取得 req.flow.lineUid。
 */
const ATTEMPTS = new Map(); // "ip:lineUid" -> { count, windowStart }
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function verifyPhoneRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
  const uid = req.flow?.lineUid || 'unknown';
  const key = `${ip}:${uid}`;
  const now = Date.now();
  const rec = ATTEMPTS.get(key);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    ATTEMPTS.set(key, { count: 1, windowStart: now });
    return next();
  }
  rec.count += 1;
  if (rec.count > MAX_ATTEMPTS) {
    console.warn(`[flowAuth] verify-phone rate-limited: ip=${ip} uidTail=***${uid.slice(-4)} attempts=${rec.count}`);
    return res.status(429).json({ error: '嘗試次數過多，請 5 分鐘後再試', code: 'RATE_LIMITED' });
  }
  next();
}

module.exports = { signFlowToken, requireFlowToken, verifyPhoneRateLimit, FLOW_TTL_SECONDS };
