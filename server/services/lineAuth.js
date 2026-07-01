/**
 * LINE Login id_token 驗證
 *
 * 用途：教練端 LIFF 登入時，前端取得 liff.getIDToken() 後傳給後端，
 * 後端呼叫 LINE Verify API 驗證 id_token 並取得 line_uid (sub)。
 *
 * Endpoint: https://api.line.me/oauth2/v2.1/verify
 * Body (x-www-form-urlencoded):
 *   - id_token: 從 LIFF 取得的 ID Token
 *   - client_id: LINE Login Channel ID
 *
 * 回傳成功時包含：iss, sub, aud, exp, iat, name, picture, email
 *   - sub = LINE 使用者 ID（line_uid）
 *   - aud = channel id（驗證 audience 是否與我方一致）
 */
const axios = require('axios');

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

function _tokenFingerprint(idToken) {
  // 安全 log：只記長度 + 前 12 碼（id_token 是長 JWT，前 12 碼為 header b64
  // 一部分，不足以拿來重放）
  if (!idToken) return 'none';
  const s = String(idToken);
  return `len=${s.length} head=${s.slice(0, 12)}…`;
}

function _channelIdTail() {
  const cid = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!cid) return 'unconfigured';
  return `***${String(cid).slice(-4)}`;
}

async function verifyLineIdToken(idToken) {
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!channelId) {
    console.warn('[lineAuth] verify aborted: LINE_LOGIN_CHANNEL_ID not configured');
    const e = new Error('LINE_LOGIN_CHANNEL_ID not configured');
    e.code = 'LINE_CHANNEL_MISCONFIGURED';
    throw e;
  }
  if (!idToken) {
    console.warn(`[lineAuth] verify aborted: id_token missing (channelId=${_channelIdTail()})`);
    const e = new Error('id_token is required');
    e.code = 'ID_TOKEN_REQUIRED';
    throw e;
  }

  const params = new URLSearchParams();
  params.append('id_token', idToken);
  params.append('client_id', channelId);

  let res;
  try {
    res = await axios.post(VERIFY_URL, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000,
      validateStatus: () => true,
    });
  } catch (err) {
    console.warn(
      `[lineAuth] verify network-error channelId=${_channelIdTail()} ` +
      `token=${_tokenFingerprint(idToken)} err=${err.message}`
    );
    const e = new Error(`LINE verify network error: ${err.message}`);
    e.code = 'LINE_VERIFY_NETWORK_ERROR';
    throw e;
  }

  if (res.status !== 200) {
    const errCode = res.data?.error || `http_${res.status}`;
    const errDesc = res.data?.error_description || '';
    console.warn(
      `[lineAuth] verify FAIL channelId=${_channelIdTail()} ` +
      `token=${_tokenFingerprint(idToken)} ` +
      `http=${res.status} error=${errCode} desc=${errDesc}`
    );
    const detail = errDesc || errCode;
    const e = new Error(`LINE id_token 驗證失敗: ${detail}`);
    // LINE 對「id_token 過期」的典型回應是 error=invalid_request + description 含 expire 字樣；
    // 用內容判斷而非硬碼單一格式，避免 LINE 端措辭微調就失效（同 ragic.js _normalizeRagicError 慣例）。
    e.code = /expir/i.test(detail) ? 'LINE_TOKEN_EXPIRED' : 'LINE_VERIFY_FAILED';
    throw e;
  }
  const payload = res.data || {};
  // 雙重檢查：audience 必須等於我們的 channel id
  if (payload.aud && String(payload.aud) !== String(channelId)) {
    console.warn(
      `[lineAuth] verify FAIL audience-mismatch channelId=${_channelIdTail()} ` +
      `payload.aud_tail=***${String(payload.aud).slice(-4)}`
    );
    const e = new Error('LINE id_token audience mismatch');
    // 這是我方 LIFF_ID / LINE_LOGIN_CHANNEL_ID 設定沒對齊，不是使用者的問題，
    // 用獨立代碼讓前端顯示「系統設定異常」而非叫使用者重試（重試也不會好）。
    e.code = 'LINE_CHANNEL_MISCONFIGURED';
    throw e;
  }
  if (!payload.sub) {
    console.warn(`[lineAuth] verify FAIL no-sub channelId=${_channelIdTail()}`);
    const e = new Error('LINE id_token 缺少 sub');
    e.code = 'LINE_VERIFY_FAILED';
    throw e;
  }
  console.log(
    `[lineAuth] verify OK channelId=${_channelIdTail()} ` +
    `aud_match=${String(payload.aud) === String(channelId)} ` +
    `sub_tail=***${String(payload.sub).slice(-4)} ` +
    `exp=${payload.exp || 'n/a'}`
  );
  return payload; // { sub, aud, iss, exp, ... }
}

/**
 * 在開發環境（NODE_ENV !== 'production'）允許跳過 LINE id_token 驗證
 * — 這樣 mock / dev workflow 不會因為缺 channelId 或缺 id_token 而崩潰，
 *   但 production 一律要求 id_token + 比對 line_uid。
 */
function isLineVerificationRequired() {
  if (process.env.NODE_ENV === 'production') return true;
  if (process.env.REQUIRE_LINE_ID_TOKEN === '1') return true;
  return false;
}

module.exports = { verifyLineIdToken, isLineVerificationRequired };
