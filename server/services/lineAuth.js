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

async function verifyLineIdToken(idToken) {
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!channelId) throw new Error('LINE_LOGIN_CHANNEL_ID not configured');
  if (!idToken) throw new Error('id_token is required');

  const params = new URLSearchParams();
  params.append('id_token', idToken);
  params.append('client_id', channelId);

  const res = await axios.post(VERIFY_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 5000,
    validateStatus: () => true,
  });

  if (res.status !== 200) {
    const detail = res.data?.error_description || res.data?.error || `HTTP ${res.status}`;
    throw new Error(`LINE id_token 驗證失敗: ${detail}`);
  }
  const payload = res.data || {};
  // 雙重檢查：audience 必須等於我們的 channel id
  if (payload.aud && String(payload.aud) !== String(channelId)) {
    throw new Error('LINE id_token audience mismatch');
  }
  if (!payload.sub) throw new Error('LINE id_token 缺少 sub');
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
