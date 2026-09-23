/**
 * Ragic Webhook 每一次請求的紀錄（含被拒的），寫進 ragic_webhook_attempts。
 *
 * 為什麼要有：原本只有「成功處理」會留在 ragic_webhook_log；密碼不符（401）、內容看不懂（400）、
 * 用錯方法（405）都只回應、不留痕跡，出事時分不出是「Ragic 根本沒送」還是「送了被我們擋掉」。
 *
 * 只記：方法、表單代碼、HTTP 狀態、結果、Content-Type、內容形狀、位元組數、編號數、User-Agent。
 * 不記：密碼（在網址參數裡）、內容本身（可能含個資）。
 *
 * 這個端點不需要登入就能打，所以：每個程序每分鐘最多寫 60 筆（被灌爆時直接略過），
 * 每小時順手清掉 30 天前的紀錄；寫入失敗只印警告，絕不影響 webhook 本身的回應。
 */
const MAX_PER_MINUTE = 60;
const KEEP_DAYS = 30;

let windowStart = 0;
let windowCount = 0;
let lastPruneAt = 0;

function clip(value, max) {
  return value == null ? null : String(value).slice(0, max);
}

async function record(entry, db) {
  try {
    const now = Date.now();
    if (now - windowStart >= 60000) { windowStart = now; windowCount = 0; }
    windowCount += 1;
    if (windowCount > MAX_PER_MINUTE) return false;
    const client = db || require('../models/db').pool;
    await client.query(
      `INSERT INTO ragic_webhook_attempts
         (method, sheet_code, status, outcome, content_type, body_kind, body_bytes, id_count, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        clip(entry.method, 10),
        clip(entry.sheetCode, 20),
        Number(entry.status) || 0,
        clip(entry.outcome, 40),
        clip(entry.contentType, 100),
        clip(entry.bodyKind, 20),
        Number.isFinite(entry.bodyBytes) ? entry.bodyBytes : null,
        Number.isFinite(entry.idCount) ? entry.idCount : null,
        clip(entry.userAgent, 200),
      ]
    );
    if (now - lastPruneAt >= 3600000) {
      lastPruneAt = now;
      await client.query(`DELETE FROM ragic_webhook_attempts WHERE received_at < NOW() - make_interval(days => $1)`, [KEEP_DAYS]);
    }
    return true;
  } catch (err) {
    console.warn('[ragic-webhook] 請求紀錄寫入失敗：', err.code || err.message);
    return false;
  }
}

function _resetForTest() {
  windowStart = 0;
  windowCount = 0;
  lastPruneAt = 0;
}

module.exports = { record, MAX_PER_MINUTE, _resetForTest };
