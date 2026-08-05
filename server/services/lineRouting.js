/**
 * LINE 推播路由 —— 決定「這個 uid 該用哪個官方帳號推」。
 *
 * ── 為什麼需要這個 ──
 * LINE 的 userId 是「每個 provider 各自獨立」的。同一個人在不同 provider 底下的
 * channel 有完全不同的 U... ID。所以 uid 從哪個 Login channel 進來，就「只能」用
 * 同 provider 的 Messaging channel 推回去；跨 provider 送必定 404。
 *
 * 2026-08-05 實測（GET /v2/bot/profile，未發訊息）：
 *   教練 → dreams400                21/25 (84%)
 *   家長 → dreams400                 8/60 (13%)   uid 有效，只是多數還沒加好友
 *   家長 → 自己主場館的官方帳號         0/60 ( 0%)   不同 provider，加好友也沒用
 *
 * 所以「用學員的 venue_id 去查 token」這個作法對家長是錯的 —— 它會安靜地送出
 * 一整排 404。路由必須依 provider 決定，不是依場館。
 *
 * ── 規則 ──
 * 查得到就用，查不到就回 null 讓呼叫端 fail-closed 並記錄原因。
 * 絕不「試試看別的 channel」—— 那正是會跑出一排 error 的作法。
 */

// Login channel（uid 的來源 provider）→ Messaging API channel key
// 加新 provider 時在這裡補一行，並確認該 Messaging channel 的 token 已設定。
const PROVIDER_ROUTES = {
  // LIFF 家長端 + 教練端共用這個 Login channel（LINE_LOGIN_CHANNEL_ID）
  '2009958451': 'dreams400',   // → @010aiefh 400_駿斯內部服務窗口
};

/**
 * uid 來源的 Login channel → 該用哪個 Messaging channel。
 * loginChannelId 省略時用環境變數（目前全站只有一個 Login channel）。
 * 回 channel key 或 null。
 */
function messagingChannelFor(loginChannelId) {
  const id = String(loginChannelId || process.env.LINE_LOGIN_CHANNEL_ID || '').trim();
  if (!id) return null;
  return PROVIDER_ROUTES[id] || null;
}

/**
 * 收訊者（家長或教練）該用哪個 channel 推。
 * row 可帶 line_login_channel_id；沒有就用全站預設。
 */
function channelForRecipient(row) {
  return messagingChannelFor(row && row.line_login_channel_id);
}

/**
 * 開機自檢：把路由表和「目標 channel 有沒有 token」印出來。
 * 路由設錯時最糟的情況是「上線後才發現一則都沒送出去」，寧可開機就吵。
 */
function selfCheck(getToken) {
  const lines = [];
  const configured = String(process.env.LINE_LOGIN_CHANNEL_ID || '').trim();
  for (const [login, ch] of Object.entries(PROVIDER_ROUTES)) {
    let state;
    try { getToken(ch); state = 'token OK'; }
    catch (e) { state = '** 沒有 token：' + e.message + ' **'; }
    lines.push('  Login ' + login + (login === configured ? ' (現行)' : '') + ' → ' + ch + '   ' + state);
  }
  if (configured && !PROVIDER_ROUTES[configured]) {
    lines.push('  ** 現行 LINE_LOGIN_CHANNEL_ID=' + configured +
      ' 不在路由表內 —— 所有推播都會被擋下（不會亂送）。請在 services/lineRouting.js 補上對應。 **');
  }
  return lines;
}

module.exports = { PROVIDER_ROUTES, messagingChannelFor, channelForRecipient, selfCheck };