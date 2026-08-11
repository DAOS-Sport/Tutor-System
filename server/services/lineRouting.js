/**
 * LINE 推播路由 —— 決定「這個人該用哪個官方帳號推」。
 *
 * ── 目標形狀 ──
 *   教練 → 固定走內部帳號 dreams400（@010aiefh）
 *   家長 → 走自己選的場館的官方帳號（primary_venue_id）；該館推不到就退回 dreams400
 *
 * ── 為什麼「推不到」是常態，而不是例外 ──
 * LINE 的 userId 是「每個 provider 各自獨立」的。本系統的 LIFF 掛在 Login channel
 * 2009958451（provider: oshuoshuo）底下，dreams400 也在同一個 provider，所以
 * parents.line_uid 對 dreams400 是有效的（2026-08-05 實測：顯示名稱 4/4 一致）。
 *
 * 但四個場館 OA（@597kqtbz 新北 / @703sndbg 三重 / @642fcufc 三民 / @318wjncz 松山）
 * 屬於另一個 provider —— 它們是舊系統 dream-dream 的資產。同一組 uid 對它們
 * 實測 0/60，加好友也沒用，因為編號天生不同。
 *
 * 所以各館預設是「關」的：開了只會每則都 404。等該館的 provider 問題解決
 * （例如在 oshuoshuo 底下開該館的 Messaging channel，或家長改從該館 channel 登入），
 * 再用下面的開關逐館打開。用開關而不是「每次試試看」，是因為後者會讓每一則
 * 推播都先浪費一次必定失敗的 API 呼叫。
 *
 * ── 開關（admin_settings，value 1＝開）──
 *   push_venue_channel_<venue_id>   例：push_venue_channel_B
 * 未設定＝關＝該館家長退回 dreams400。
 */
const { pool } = require('../models/db');

// 場館代號 ↔ 館名別名。token 兩種設定法都吃：
//   LINE_MESSAGING_TOKENS 的 key（可用場館代號或館名），或 LINE_MESSAGING_TOKEN_<名稱>
const VENUE_ENV_ALIAS = {
  B: ['NEWPEI', 'XINBEI'],   // 新北高中
  K: ['SANCHONG'],           // 三重商工
  L: ['SANMIN'],             // 三民高中
  C: ['SONGSHAN'],           // 松山國小
};

/**
 * 各場館官方帳號的 basic ID。用途只有一個：產生 deep link
 * （報名成功信的「點擊登入家教系統」按鈕）。
 *
 * ⚠️ 上面那段 provider 障礙（同一組 uid 對這四個 OA 實測 0/60）在這裡**不成立**。
 * 推播是「我方 → 使用者」，得先認得對方的 uid，所以跨 provider 必死；
 * deep link 是「使用者在自己的 LINE App 裡點開一個聊天視窗」，我方不需要
 * 認得他，也不需要 token。所以推播打不通的館，這條路照樣走得通。
 *
 * 值來自 server/services/lineRouting.js 既有註解（舊系統 dream-dream 的資產），
 * 尚未經 owner 逐一覆核。要換用 LINE_OA_ID_<場館代號或別名> 覆寫，例：
 *   LINE_OA_ID_B=@xxxxxxx   或   LINE_OA_ID_NEWPEI=@xxxxxxx
 */
const VENUE_OA_ID = {
  B: '@597kqtbz',   // 新北高中
  K: '@703sndbg',   // 三重商工
  L: '@642fcufc',   // 三民高中
  C: '@318wjncz',   // 松山國小
};

// 深連結預設要幫家長帶入的訊息。家長只要按送出，官方帳號就會回登入入口。
const OA_LOGIN_KEYWORD = process.env.LINE_OA_LOGIN_KEYWORD || '家教系統';

// LINE basic ID 一律是 @ 開頭的英數與 . _ -。格式不合就當作沒設定 ——
// 錯的 ID 會把家長帶到別人的帳號或死連結，寧可退回原本的 LIFF 連結。
const OA_ID_RE = /^@[A-Za-z0-9_.-]+$/;

/** 取某場館的 OA basic ID；沒有對應或格式不合回 null。env 覆寫優先。 */
function venueOaId(venueId) {
  const v = String(venueId || '').trim();
  if (!v) return null;
  const keys = [v, ...(VENUE_ENV_ALIAS[v] || [])];
  for (const k of keys) {
    const raw = String(process.env['LINE_OA_ID_' + k] || '').trim();
    if (raw) return OA_ID_RE.test(raw) ? raw : null;   // 有設但設錯 → 不要偷偷用內建值蓋過去
  }
  const built = VENUE_OA_ID[v];
  return built && OA_ID_RE.test(built) ? built : null;
}

/**
 * 產生「開啟該館官方帳號、訊息欄預先帶入一段文字」的深連結。
 *
 * 注意：oaMessage 只會**帶入**文字，不會自動送出 —— 這是 LINE 官方的行為，
 * 沒有任何參數可以繞過（已查證官方文件）。家長要自己按送出。所以信裡的
 * 說明文字必須講清楚這一步，不然家長會以為按了沒反應。
 *
 * @returns {string|null} 該館沒有對應 OA 時回 null，呼叫端自行退回原連結
 */
function venueOaDeepLink(venueId, text = OA_LOGIN_KEYWORD) {
  const id = venueOaId(venueId);
  if (!id) return null;
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(text)}`;
}

// 教練固定用這個；家長在場館推不到時也退回它。
const STAFF_CHANNEL = process.env.LINE_STAFF_CHANNEL_KEY || 'dreams400';

const VENUE_FLAG = (venueId) => 'push_venue_channel_' + venueId;

// 開關讀 admin_settings（value 是 NUMERIC，1＝開），快取 60 秒 ——
// 推播是熱路徑，但也不能久到「改了設定要等很久才生效」。
let _cache = { at: 0, map: {} };
async function loadVenueFlags(db = pool) {
  const now = Date.now();
  if (now - _cache.at < 60000) return _cache.map;
  const map = {};
  try {
    const r = await db.query(
      `SELECT key, value FROM admin_settings WHERE key LIKE 'push\\_venue\\_channel\\_%' ESCAPE '\\'`);
    r.rows.forEach((x) => { map[String(x.key).replace('push_venue_channel_', '')] = Number(x.value) === 1; });
  } catch (e) {
    console.warn('[lineRouting] 讀取場館開關失敗，全部視為關閉：' + e.message);
  }
  _cache = { at: now, map };
  return map;
}

/**
 * 決定收訊者的 Messaging channel。
 * @param {'parent'|'coach'} kind
 * @param {string} [venueId] 家長的主場館（parents.primary_venue_id）
 * @returns {Promise<{channel: string, reason: string}>}
 */
async function resolveChannel({ kind, venueId }, db = pool) {
  if (kind === 'coach') return { channel: STAFF_CHANNEL, reason: 'coach_fixed' };

  if (venueId) {
    const flags = await loadVenueFlags(db);
    if (flags[venueId]) return { channel: venueId, reason: 'venue' };
  }
  // 場館沒開／沒有場館 → 退回能用的固定帳號
  return { channel: STAFF_CHANNEL, reason: venueId ? 'venue_disabled_fallback' : 'no_venue_fallback' };
}

/** 維運自檢：印出每個場館目前會走哪個帳號，以及 token 在不在。 */
async function selfCheck(getToken, db = pool) {
  const out = [];
  const flags = await loadVenueFlags(db);
  const tok = (ch) => { try { getToken(ch); return 'token OK'; } catch (e) { return '** 無 token **'; } };
  out.push('  教練  → ' + STAFF_CHANNEL + '   ' + tok(STAFF_CHANNEL));
  for (const v of Object.keys(VENUE_ENV_ALIAS)) {
    const on = !!flags[v];
    out.push('  家長 ' + v + ' → ' + (on ? v + '   ' + tok(v) : STAFF_CHANNEL + '（該館開關未開，退回）   ' + tok(v) + '（該館 token 狀態）'));
  }
  out.push('  家長（無場館）→ ' + STAFF_CHANNEL);
  return out;
}

/**
 * 我方認可的 LINE Login channel（lineAuth 的白名單）。
 * 目前家長與教練都走 LINE_LOGIN_CHANNEL_ID；LINE_LOGIN_ID_* 是舊系統 dream-dream
 * 的各館 channel，留在白名單內是為了「萬一有人從那邊的 LIFF 進來也能登入」，
 * 不影響推播路由（推播只看 primary_venue_id 與場館開關）。
 */
function allowedLoginChannels() {
  const ids = new Set();
  const staff = String(process.env.LINE_LOGIN_CHANNEL_ID || '').trim();
  if (staff) ids.add(staff);
  for (const names of Object.values(VENUE_ENV_ALIAS)) {
    for (const n of names) {
      const v = String(process.env['LINE_LOGIN_ID_' + n] || '').trim();
      if (v) ids.add(v);
    }
  }
  return [...ids];
}

module.exports = {
  VENUE_ENV_ALIAS, STAFF_CHANNEL, VENUE_FLAG, VENUE_OA_ID, OA_LOGIN_KEYWORD,
  loadVenueFlags, resolveChannel, selfCheck, allowedLoginChannels,
  venueOaId, venueOaDeepLink,
};