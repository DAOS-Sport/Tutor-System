/**
 * LINE 推播路由 —— 決定「這個人該用哪個官方帳號推」。
 *
 * ── 核心事實 ──
 * LINE 的 userId 是「每個 provider 各自獨立」的。uid 從哪個 Login channel 發出來，
 * 就只能用同 provider 的 Messaging channel 推回去，跨 provider 必定 404。
 * 所以規則很單純：**從哪個 provider 進來，就推回哪個 provider。**
 *
 * ── 本專案的 provider 結構 ──
 *   各場館：LINE_LOGIN_ID_<NAME>  +  LINE_MESSAGING_TOKEN_<NAME>   （家長）
 *   員工：  LINE_LOGIN_CHANNEL_ID +  LINE_MESSAGING_TOKENS.dreams400（教練）
 * <NAME> 是兩者的接合鍵（NEWPEI / SANCHONG / SANMIN / SONGSHAN），
 * 所以路由表用環境變數即時組出來 —— 新增場館只要加那兩個 Secret，程式不用改。
 *
 * ── 邊界 ──
 * 家長只能走自己場館的官方帳號。dreams400 是員工在用的內部窗口，
 * 把家長通知送進去，家長收不到、員工被灌一堆不相干的訊息 —— 刻意沒有保底值。
 * 查不到目的地就回 null，呼叫端記錄原因並跳過，絕不試別的 channel。
 */

// 場館代號 → 環境變數用的名稱。第一個是主要名稱，其餘為歷史別名。
// 新增場館時在這裡補一行，並設好 LINE_LOGIN_ID_<NAME> 與 LINE_MESSAGING_TOKEN_<NAME>。
const VENUE_ENV_ALIAS = {
  B: ['NEWPEI', 'XINBEI'],   // 新北高中
  K: ['SANCHONG'],           // 三重商工
  L: ['SANMIN'],             // 三民高中
  C: ['SONGSHAN'],           // 松山國小
};

// 教練／員工用的 Messaging channel key（在 LINE_MESSAGING_TOKENS 內）
const STAFF_CHANNEL = process.env.LINE_STAFF_CHANNEL_KEY || 'dreams400';

/**
 * 依目前環境組出 provider 路由表。
 * 每個 provider： { label, parent, coach }
 *   parent 該 provider 給家長用的 Messaging channel（＝場館代號）
 *   coach  該 provider 給教練用的 Messaging channel
 * 不快取 —— 這不是熱路徑，而快取會讓「補了 Secret 卻沒生效」變成難查的問題。
 */
function buildProviders() {
  const out = {};

  // 各場館 provider：家長從自己館的 LIFF 進來
  for (const [venue, names] of Object.entries(VENUE_ENV_ALIAS)) {
    for (const n of names) {
      const id = String(process.env['LINE_LOGIN_ID_' + n] || '').trim();
      if (!id) continue;
      out[id] = { label: venue + ' 館（' + n + '）', parent: venue, coach: null };
      break;   // 同一場館只認第一個有設定的名稱
    }
  }

  // 員工 provider：教練從這裡進來。放在後面，若與場館撞號則以場館為準（家長優先）。
  const staffLogin = String(process.env.LINE_LOGIN_CHANNEL_ID || '').trim();
  if (staffLogin && !out[staffLogin]) {
    out[staffLogin] = { label: '員工／教練', parent: null, coach: STAFF_CHANNEL };
  }
  return out;
}

const currentLoginChannel = () => String(process.env.LINE_LOGIN_CHANNEL_ID || '').trim();

function providerFor(loginChannelId) {
  const id = String(loginChannelId || currentLoginChannel()).trim();
  if (!id) return null;
  return buildProviders()[id] || null;
}

/** 這個 Login channel 是否為我方認可的（供 lineAuth 白名單驗證用） */
function isKnownLoginChannel(id) {
  const k = String(id || '').trim();
  return !!(k && buildProviders()[k]);
}

/** 我方所有認可的 Login channel id */
function allowedLoginChannels() {
  return Object.keys(buildProviders());
}

/**
 * 決定收訊者的 Messaging channel。
 * @param {object} r
 * @param {'parent'|'coach'} r.kind
 * @param {string} [r.loginChannelId] 來源 Login channel（省略＝用現行的）
 * @param {string} [r.venueId]        家長主場館，僅作交叉檢核，不參與決策
 * @returns {string|null} channel key，或 null（不可送）
 */
function channelForRecipient(r) {
  const p = providerFor(r && r.loginChannelId);
  if (!p) return null;
  if (r && r.kind === 'coach') return p.coach || null;
  // 家長：uid 只在自己 provider 內有效，所以目的地由 provider 決定，
  // 不看 primary_venue_id —— 那只是我方資料，改不了 uid 的歸屬。
  return p.parent || null;
}

/** 交叉檢核：家長的主場館與其來源 provider 對不對得上（不一致不擋，只回報） */
function venueMismatch(r) {
  const p = providerFor(r && r.loginChannelId);
  if (!p || !p.parent || !r || !r.venueId) return null;
  return p.parent === r.venueId ? null : { expected: p.parent, actual: r.venueId };
}

/** 維運自檢：印出路由表與各目的地有無 token。 */
function selfCheck(getToken) {
  const out = [];
  const providers = buildProviders();
  const cur = currentLoginChannel();
  const ids = Object.keys(providers);
  if (!ids.length) { out.push('  ** 路由表是空的 —— 沒有任何 Login channel 設定，所有推播都會被擋下。 **'); return out; }
  for (const id of ids) {
    const p = providers[id];
    out.push('  Login ' + id + (id === cur ? ' (LINE_LOGIN_CHANNEL_ID)' : '') + '  ' + p.label);
    for (const [role, ch] of [['家長', p.parent], ['教練', p.coach]]) {
      if (!ch) { out.push('      ' + role + ' → （不送）'); continue; }
      let state;
      try { getToken(ch); state = 'token OK'; }
      catch (e) { state = '** 沒有 token：' + e.message + ' **'; }
      out.push('      ' + role + ' → ' + String(ch).padEnd(12) + state);
    }
  }
  // 場館有 Messaging token 但沒有 Login channel → 家長進不來，推播也無從送起
  for (const [venue, names] of Object.entries(VENUE_ENV_ALIAS)) {
    const hasLogin = names.some((n) => String(process.env['LINE_LOGIN_ID_' + n] || '').trim());
    if (hasLogin) continue;
    let hasToken = false;
    try { getToken(venue); hasToken = true; } catch (_) { /* 沒有就算了 */ }
    if (hasToken) out.push('  ** ' + venue + ' 館有 Messaging token 但沒有 LINE_LOGIN_ID_'
      + names[0] + ' —— 家長無法從該館登入，推播也送不出去。 **');
  }
  return out;
}

module.exports = {
  VENUE_ENV_ALIAS, STAFF_CHANNEL,
  buildProviders, providerFor, channelForRecipient, venueMismatch,
  isKnownLoginChannel, allowedLoginChannels, selfCheck,
};