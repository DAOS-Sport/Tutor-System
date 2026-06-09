/**
 * 教練查無 → 推播 IT 管理員（模板 §0 C 層 / §5 link-by-name 查無分支）
 *
 * 設計為「可選 + graceful」：
 *   - 目標 ID：LINE_IT_GROUP_ID（群組）優先，否則 ADMIN_ALERT_LINE_USER_ID（個人）。
 *   - access token：重用 LINE_MESSAGING_TOKENS 內的一支；預設挑 dreams400
 *     （= 400 官方帳號，最可能在 IT 群組裡）。可用 IT_ALERT_MESSAGING_KEY 覆寫挑哪個 key。
 *   - 未設目標 / 無 token / 推播失敗 → 只記 log，絕不 throw 給呼叫端（不擋登入流程）。
 */
const axios = require('axios');

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const TIMEOUT = Number(process.env.OUTBOUND_HTTP_TIMEOUT_MS) || 8000;

function target() {
  return process.env.LINE_IT_GROUP_ID || process.env.ADMIN_ALERT_LINE_USER_ID || '';
}

function messagingToken() {
  let map = {};
  try { map = JSON.parse(process.env.LINE_MESSAGING_TOKENS || '{}'); } catch { map = {}; }
  const preferred = process.env.IT_ALERT_MESSAGING_KEY || 'dreams400';
  return map[preferred] || Object.values(map)[0] || '';
}

function isConfigured() {
  return Boolean(target() && messagingToken());
}

/**
 * 推播「教練登入查無對應」給 IT。
 * @returns {Promise<boolean>} 是否實際送出（未設定 / 失敗 → false，但不會 throw）
 */
async function pushCoachUnbound({ lineUid, displayName, name }) {
  const to = target();
  const token = messagingToken();
  if (!to || !token) {
    console.warn(
      `[itAlert] 跳過推播（未設 target/token）：教練登入查無 ` +
      `name=${name || '?'} line=***${String(lineUid || '').slice(-4)}`
    );
    return false;
  }
  const text =
    '🟡 教練登入查無對應\n' +
    `LINE 名稱：${displayName || '(未知)'}\n` +
    `輸入姓名：${name || '(未輸入)'}\n` +
    `LINE UID：${lineUid || '(無)'}\n` +
    '請至 Ragic H01 確認該員工「個人LINE ID / 姓名」是否正確，或協助手動綁定。';
  try {
    await axios.post(
      PUSH_URL,
      { to, messages: [{ type: 'text', text }] },
      { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT, validateStatus: () => true }
    );
    return true;
  } catch (e) {
    console.warn('[itAlert] 推播失敗（已忽略）:', e.message);
    return false;
  }
}

module.exports = { pushCoachUnbound, isConfigured };
