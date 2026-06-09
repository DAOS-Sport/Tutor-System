/**
 * 教練端 LINE OAuth web 流程封裝（authorization code flow）
 * 模板移植：server/modules/auth.routes.ts 的「換 token / 取 profile」核心。
 *
 * 重要決策（依使用者確認）：教練 OAuth「沿用家長端同一個 LINE Login channel」
 *   = LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET（末碼 8451）。
 *   原因：LINE userId 綁 channel/provider，換 channel 會拿到不同的 U... id，
 *   與 Ragic H01「個人LINE ID」及 coaches.line_uid 既有資料對不起來。
 *
 * 端點：
 *   authorize → https://access.line.me/oauth2/v2.1/authorize
 *   token     → https://api.line.me/oauth2/v2.1/token
 *   profile   → https://api.line.me/v2/profile
 */
const axios = require('axios');

const AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
const PROFILE_URL = 'https://api.line.me/v2/profile';
const TIMEOUT = Number(process.env.OUTBOUND_HTTP_TIMEOUT_MS) || 8000;

function channelId() { return process.env.LINE_LOGIN_CHANNEL_ID || ''; }
function channelSecret() { return process.env.LINE_LOGIN_CHANNEL_SECRET || ''; }

function isConfigured() {
  return Boolean(channelId() && channelSecret());
}

// 對外網址：優先 PUBLIC_ORIGIN，否則由 Replit 注入的 REPLIT_DOMAINS / REPLIT_DEV_DOMAIN 推導。
function publicOrigin() {
  if (process.env.PUBLIC_ORIGIN) return String(process.env.PUBLIC_ORIGIN).replace(/\/$/, '');
  const domains = process.env.REPLIT_DOMAINS || process.env.REPLIT_DEV_DOMAIN || '';
  const first = String(domains).split(',')[0].trim();
  return first ? `https://${first}` : '';
}

// LINE Console「Callback URL」白名單要設成這個值。
function redirectUri() {
  return `${publicOrigin()}/api/coach-portal/auth/line/callback`;
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: channelId(),
    redirect_uri: redirectUri(),
    state,
    scope: 'profile openid',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// 用授權碼換 access_token（需 client_secret）
async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: channelId(),
    client_secret: channelSecret(),
  });
  const res = await axios.post(TOKEN_URL, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: TIMEOUT,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    const detail = res.data?.error_description || res.data?.error || `http_${res.status}`;
    throw new Error(`LINE token 交換失敗: ${detail}`);
  }
  return res.data; // { access_token, id_token, expires_in, ... }
}

// 用 access_token 取得使用者 profile（userId = line_uid）
async function getProfile(accessToken) {
  const res = await axios.get(PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: TIMEOUT,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(`LINE profile 取得失敗: http_${res.status}`);
  }
  return res.data; // { userId, displayName, pictureUrl }
}

module.exports = {
  isConfigured, publicOrigin, redirectUri, buildAuthorizeUrl,
  exchangeCodeForToken, getProfile, channelId,
};
