/**
 * 登入／查詢速率限制的總開關與共用工具。
 *
 * ── 這個檔案存在的理由 ──
 * 2026-08-26 正式站全體無法登入後台，錯誤是 429。原因不是上限太低，而是
 * 後台登入以 req.ip 為 key，而 app 從未設過 trust proxy —— 在 Replit Autoscale
 * 的反向代理後面，req.ip 拿到的是代理位址，對所有使用者都一樣。
 * 「5 分鐘 5 次」於是變成「整個系統 5 分鐘 5 次」，超過就全公司一起鎖死。
 *
 * 另外兩個缺陷讓它解不開：
 *   - 被擋下的請求也計數 → 每次重試都把冷卻往後推，持續按就永遠恢復不了
 *   - 成功登入也計數，且從不清零
 *
 * ── 設計上的關鍵決定：認不出用戶就不要限流 ──
 * 上面那場事故的本質是「識別失敗時，把所有人當成同一個人」。
 * 只把上限從 5 調到 30 並不能消除它，只是讓它晚一點發生。
 * 所以這裡改成：取不到可辨識的用戶位址時，直接放行並記一次警告。
 *
 * 失效方向因此從「全員鎖死」翻成「暫時不限流」。前者會讓整間公司停止營運，
 * 後者只是短暫少一層防護 —— 而且警告會讓人知道要去修 trust proxy 設定。
 * 這是刻意選的方向，不是疏忽。
 */
'use strict';

/** 預設啟用。設 RATE_LIMIT_ENABLED=0 可整組關閉（緊急用）。 */
function rateLimitEnabled() {
  const raw = String(process.env.RATE_LIMIT_ENABLED ?? '1').trim();
  return !/^(0|false|no|off)$/i.test(raw);
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX = 30;

function windowMs() {
  const n = Number(process.env.RATE_LIMIT_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_MS;
}

/**
 * 每個「可辨識用戶」在時間窗內的次數上限。
 *
 * 30 是估出來的，不是猜的：後台實際只有約 17 個帳號，交接班時同一人重登
 * 也不過三五次。30 對正常使用綽綽有餘，對逐一嘗試密碼則遠遠不夠 ——
 * 預設密碼是 10 碼手機號，30 次 / 5 分鐘的速度沒有實質意義。
 */
function maxAttempts() {
  const n = Number(process.env.RATE_LIMIT_MAX);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX;
}

/**
 * 取得可辨識的用戶位址；辨識不出來回 null。
 *
 * 回 null 的意思是「我不知道這是誰」，呼叫端必須放行而不是把它併成一桶。
 * req.ip 只有在 trust proxy 設定正確時才可信，所以優先看 x-forwarded-for ——
 * 專案裡其他七個限流點本來就是這樣寫的，只有後台登入漏了。
 */
function clientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for'];
  const first = typeof fwd === 'string' ? fwd.split(',')[0].trim() : '';
  if (first) return first;
  const direct = String(req?.ip || req?.socket?.remoteAddress || '').trim();
  // 'unknown' / 空字串代表辨識失敗。本機開發的 ::1 / 127.0.0.1 是真的單機，可用。
  return direct && direct !== 'unknown' ? direct : null;
}

let _warnedNoIp = 0;
function _warnNoIp(label) {
  const now = Date.now();
  if (now - _warnedNoIp < 60_000) return;   // 每分鐘最多提醒一次，不洗版
  _warnedNoIp = now;
  console.warn(`[rateLimit] ${label}：取不到可辨識的用戶位址，本次不限流。`
    + '請確認反向代理有帶 x-forwarded-for、且 app.set("trust proxy") 已設定。');
}

/**
 * 滑動視窗計數。回 true 表示已超限、應拒絕。
 *
 * 兩個與舊版的關鍵差異：
 *   1. key 為 null（辨識不出用戶）→ 一律放行
 *   2. 已超限時不再累加 —— 否則使用者每按一次都把冷卻往後推，永遠解不開
 */
function hit(bucket, key, opts = {}) {
  if (!rateLimitEnabled()) return false;
  if (!key) { _warnNoIp(opts.label || 'unknown'); return false; }

  const win = opts.windowMs || windowMs();
  const max = opts.max || maxAttempts();
  const now = Date.now();
  const arr = (bucket.get(key) || []).filter((t) => now - t < win);
  if (arr.length >= max) {
    bucket.set(key, arr);          // 只保留有效的，不因為被擋而延長
    return true;
  }
  arr.push(now);
  bucket.set(key, arr);
  if (bucket.size > 5000) bucket.clear();
  return false;
}

/** 成功之後清零：正常使用不該累積額度。 */
function reset(bucket, key) {
  if (key) bucket.delete(key);
}

module.exports = {
  rateLimitEnabled, clientIp, hit, reset, windowMs, maxAttempts,
  DEFAULT_WINDOW_MS, DEFAULT_MAX,
};

