/**
 * LINE 推播路由 —— 決定「這個人該用哪個官方帳號推」。
 *
 * ── 兩層判斷，順序不可顛倒 ──
 *   第一層（正確性）：uid 屬於哪個 provider？
 *       LINE 的 userId 是 per-provider 的。uid 從哪個 Login channel 發出來，就只能用
 *       同 provider 的 Messaging channel 推回去，跨 provider 必定 404。
 *       來源記在 parents/coaches.line_login_channel_id（登入時由 lineIdentity 寫入）；
 *       沒有記錄就退回環境變數的現行 Login channel。
 *   第二層（意圖）：在那個 provider 底下，這個角色該送哪一個帳號？
 *       教練 → 內部帳號；家長 → 自己主場館的帳號。
 *
 * 先判 provider 再判角色，是因為「家長要從各館推」是意圖，而「uid 對不對得上」
 * 是事實。事實不成立時寧可不送並記錄原因，也不要送出一整排 404。
 *
 * ── 現況（2026-08-05 實測）──
 * 目前只有一個 Login channel（2009958451），它同 provider 底下只有 dreams400，
 * 所以家長與教練都路由到 dreams400。四個場館 OA 在另一個 provider，
 * 家長 uid 對它們的可達率實測 0/36 —— 加好友也沒用。
 * 等家長端 LIFF 換到場館那個 provider 的 Login channel 後，在下面補一組設定，
 * 家長就會自動改推到自己的場館帳號，程式不用改。
 */

/**
 * Login channel（＝provider 的入口）→ 該 provider 底下的推播目的地。
 *   coach    這個 provider 給教練用的 Messaging channel
 *   venues   venue_id → Messaging channel，家長依主場館對應
 *   fallback 角色/場館查不到時的保底（沒有就填 null，寧可不送）
 */
const PROVIDERS = {
  '2009958451': {
    label: 'LIFF 家長端＋教練端（現行）',
    coach: 'dreams400',
    venues: {},            // 這個 provider 底下沒有場館 OA
    fallback: 'dreams400', // 所以家長也只能走內部帳號
  },

  // ── 家長端遷移到場館 provider 後，把新的 Login channel id 填進來即可 ──
  // '<新的 Login channel id>': {
  //   label: '場館 provider',
  //   coach: null,
  //   venues: { B: 'B', K: 'K', L: 'L', C: 'C' },
  //   fallback: null,      // 查無場館就不送，不亂找
  // },
};

const currentLoginChannel = () => String(process.env.LINE_LOGIN_CHANNEL_ID || '').trim();

function providerFor(loginChannelId) {
  const id = String(loginChannelId || currentLoginChannel()).trim();
  return id ? (PROVIDERS[id] || null) : null;
}

/**
 * 決定收訊者的 Messaging channel。
 * @param {object} r
 * @param {'parent'|'coach'} r.kind
 * @param {string} [r.venueId]              家長的主場館（parents.primary_venue_id）
 * @param {string} [r.loginChannelId]       來源 Login channel（省略＝用現行的）
 * @returns {string|null} channel key，或 null（＝不可送，呼叫端須記錄原因並跳過）
 */
function channelForRecipient(r) {
  const p = providerFor(r && r.loginChannelId);
  if (!p) return null;
  if (r && r.kind === 'coach') return p.coach || p.fallback || null;
  const byVenue = r && r.venueId ? p.venues[r.venueId] : null;
  return byVenue || p.fallback || null;
}

// 相容舊呼叫：只問「現行 provider 對應哪個 channel」。
function messagingChannelFor(loginChannelId) {
  const p = providerFor(loginChannelId);
  return p ? (p.fallback || p.coach || null) : null;
}

/**
 * 開機/維運自檢：印出路由表與各目的地有無 token。
 * 路由設錯最糟的情況是「上線後才發現一則都沒送出去」，寧可開機就吵。
 */
function selfCheck(getToken) {
  const out = [];
  const cur = currentLoginChannel();
  for (const [login, p] of Object.entries(PROVIDERS)) {
    out.push('  Login ' + login + (login === cur ? ' (現行)' : '') + '  ' + p.label);
    const targets = new Set([p.coach, p.fallback, ...Object.values(p.venues)].filter(Boolean));
    for (const ch of targets) {
      let state;
      try { getToken(ch); state = 'token OK'; }
      catch (e) { state = '** 沒有 token：' + e.message + ' **'; }
      out.push('      → ' + String(ch).padEnd(12) + state);
    }
    out.push('      教練 → ' + (p.coach || p.fallback || '（不送）'));
    out.push('      家長 → ' + (Object.keys(p.venues).length
      ? '依主場館 ' + JSON.stringify(p.venues)
      : (p.fallback || '（不送）')));
  }
  if (cur && !PROVIDERS[cur]) {
    out.push('  ** 現行 LINE_LOGIN_CHANNEL_ID=' + cur + ' 不在路由表內 —— 所有推播都會被擋下'
      + '（不會亂送）。請在 services/lineRouting.js 的 PROVIDERS 補上。 **');
  }
  return out;
}

module.exports = { PROVIDERS, providerFor, channelForRecipient, messagingChannelFor, selfCheck };