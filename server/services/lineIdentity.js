/**
 * LINE 身分來源記錄。
 *
 * LINE 的 userId 是「每個 provider 各自獨立」的 —— uid 從哪個 Login channel 發出來，
 * 就只能用同 provider 的 Messaging channel 推回去，跨 provider 必定 404。
 *
 * 驗證 id_token 的當下（payload.aud）是「唯一」拿得到來源 channel 的時機，
 * 錯過就再也回不來 —— uid 本身看不出來源，事後只能靠逐一打 API 猜。
 * 所以這裡在每次登入時把它記下來，供 services/lineRouting.js 決定推播路徑。
 *
 * 對既有資料：欄位留 NULL，lineRouting 會退回環境變數的現行 Login channel，
 * 行為與加欄位前完全相同。等使用者下次登入就會自動補上。
 *
 * 這也是「換 Login channel」能漸進遷移的前提：已用新 channel 登入過的人推新的、
 * 還沒重新登入的推舊的，兩邊同時正確，不會有全體斷線的切換瞬間。
 */
const { pool } = require('../models/db');

// 同一個 (uid, aud) 短時間內不重複打 DB —— 登入熱路徑，能省則省。
const _seen = new Map();
const TTL_MS = 10 * 60 * 1000;

/**
 * 記錄 uid 的來源 Login channel。best-effort：失敗絕不可擋住登入。
 * @param {string} lineUid  profile.sub
 * @param {string} aud      profile.aud（Login channel id）
 */
async function recordLoginChannel(lineUid, aud, db = pool) {
  const uid = String(lineUid || '').trim();
  const cid = String(aud || '').trim();
  if (!uid || !cid) return false;

  const key = uid + '|' + cid;
  const now = Date.now();
  const hit = _seen.get(key);
  if (hit && now - hit < TTL_MS) return true;

  try {
    // 兩張表都試：同一個 uid 可能是家長、也可能是教練（少數人兩者皆是）。
    // 只在「值不同」時才寫，避免每次登入都製造無謂的 UPDATE。
    await db.query(
      `UPDATE parents SET line_login_channel_id = $2, updated_at = NOW()
        WHERE line_uid = $1 AND line_login_channel_id IS DISTINCT FROM $2`, [uid, cid]);
    await db.query(
      `UPDATE coaches SET line_login_channel_id = $2, updated_at = NOW()
        WHERE line_uid = $1 AND line_login_channel_id IS DISTINCT FROM $2`, [uid, cid]);
    _seen.set(key, now);
    if (_seen.size > 5000) _seen.clear();
    return true;
  } catch (e) {
    console.warn('[lineIdentity] 記錄來源 channel 失敗（不影響登入）：' + e.message);
    return false;
  }
}

module.exports = { recordLoginChannel };