/**
 * LINE 推播路由 —— 決定「這個人該用哪個官方帳號推」。
 *
 * ── 目前形狀：只有一個管道 ──
 *   教練與家長都走內部帳號 dreams400（@010aiefh）。
 *
 * 2026-08-12 移除「家長走自己場館的官方帳號」那條路，連同各館開關
 * （admin_settings 的 push_venue_channel_*）與各館 token。理由是它從來沒有
 * 能用過，卻讓 25 個場館裡的 21 個每次被查到就噴一行 ERROR，把真問題淹掉。
 * 要復活的話，前提是先解決下面那段 provider 障礙，不是把開關加回來。
 *
 * ⚠️ 這裡講的是**推播**（我方 → 使用者，需要 uid）。信件裡「開啟該館官方帳號」
 * 的深連結是另一回事，不受 provider 障礙影響，見本檔下半的 venueOaDeepLink。
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
 * 要讓各館能推，得先在 oshuoshuo 底下開該館的 Messaging channel，或讓家長改從
 * 該館 channel 登入 —— 兩者都會動到現存所有 uid。在那之前，任何「逐館打開」的
 * 開關都只是讓每一則推播先浪費一次必定失敗的 API 呼叫。
 */

// 場館代號 ↔ 館名別名。現在只剩 LINE_OA_ID_<別名> 與 LINE_LOGIN_ID_<別名> 在用；
// 推播 token 的各館查表已移除。
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
 * 這四組 ID 已於 2026-08-12 經 owner 逐一覆核確認無誤。改動前要再問一次 ——
 * 錯的 ID 不會報錯，只會把家長靜靜帶到別人的官方帳號。
 * 不改 code 的換法：LINE_OA_ID_<場館代號或別名>，例
 *   LINE_OA_ID_B=@xxxxxxx   或   LINE_OA_ID_NEWPEI=@xxxxxxx
 */
const VENUE_OA_ID = {
  B: '@597kqtbz',   // 新北高中
  K: '@703sndbg',   // 三重商工
  L: '@642fcufc',   // 三民高中
  C: '@318wjncz',   // 松山國小
};

// 深連結預設要幫家長帶入的訊息。家長只要按送出，官方帳號就會回登入入口。
//
// ⚠️ 這個值必須與各館官方帳號那端設定的**自動回應觸發關鍵字逐字相同**。
// 差一個字就是「家長按了送出、然後什麼都沒發生」—— 而且不會有任何錯誤，
// 我方這端完全看不出來。要改的話兩邊要一起改。
const OA_LOGIN_KEYWORD = process.env.LINE_OA_LOGIN_KEYWORD || '新家教系統登入';

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

// 全站唯一的推播管道。
const STAFF_CHANNEL = process.env.LINE_STAFF_CHANNEL_KEY || 'dreams400';

/**
 * 決定收訊者的 Messaging channel。
 *
 * 2026-08-12 起一律回 STAFF_CHANNEL —— 「各館走各館官方帳號」那條路已移除，
 * 理由見檔頭。簽章保持不變（十幾個呼叫端都在用 `.channel`），回傳的 reason
 * 仍然分得出是教練還是家長、有沒有場館，line_push_log 的可追查性不受影響。
 *
 * @param {'parent'|'coach'} kind
 * @param {string} [venueId] 家長的主場館，現在只影響 reason 字串
 * @returns {Promise<{channel: string, reason: string}>}
 */
async function resolveChannel({ kind, venueId }) {
  if (kind === 'coach') return { channel: STAFF_CHANNEL, reason: 'coach_fixed' };
  return { channel: STAFF_CHANNEL, reason: venueId ? 'parent_venue_' + venueId : 'parent_no_venue' };
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
  VENUE_ENV_ALIAS, STAFF_CHANNEL, VENUE_OA_ID, OA_LOGIN_KEYWORD,
  resolveChannel, allowedLoginChannels,
  venueOaId, venueOaDeepLink,
};