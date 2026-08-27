/**
 * 登入／查詢速率限制的總開關與共用工具。
 *
 * ── 為什麼會有這個檔案 ──
 * 2026-08-26 正式站全體無法登入。原因是後台登入的限流以 req.ip 為 key，而
 * app 沒有設 trust proxy —— 在 Replit Autoscale 的反向代理後面，req.ip 拿到的是
 * 代理伺服器位址，對所有使用者都一樣。規則是「5 分鐘 5 次」，於是實際效果變成
 * 「整個系統每 5 分鐘只允許 5 次登入」，超過就全公司一起鎖死。
 *
 * 更糟的是三個缺陷疊在一起，讓它解不開：
 *   1. 共用計數桶（上述）
 *   2. 被擋下的請求也計數 —— push 在判斷之前，所以重試會不斷延長時間窗
 *   3. 成功登入也計數，而且從不清零
 * 只要有人持續重試，就永遠不會恢復。
 *
 * ── 目前預設關閉 ──
 * 使用者於 2026-08-26 明確要求後台與前台都不限流。這裡照做，但保留完整實作，
 * 設 RATE_LIMIT_ENABLED=1 即可恢復，不需要改程式。
 *
 * ⚠ 關閉期間，後台登入可被無限次嘗試。後台預設帳密是「員工編號＋電話號碼」，
 *   兩者都可推測，也都可能從其他管道取得。這是已知且經過決定的取捨。
 */
'use strict';

/** 預設關閉；設 RATE_LIMIT_ENABLED=1 才啟用。 */
function rateLimitEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.RATE_LIMIT_ENABLED || '').trim());
}

/**
 * 取真實用戶 IP。
 *
 * 一律先看 x-forwarded-for —— 專案裡其他七個限流點本來就是這樣寫的，
 * 只有後台登入漏了，才會發生全體共用同一個計數桶。
 * 沒有 trust proxy 時 req.ip 在這個部署環境是代理位址，不可單獨依賴。
 */
function clientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for'];
  const first = typeof fwd === 'string' ? fwd.split(',')[0] : null;
  return String(first || req?.ip || req?.socket?.remoteAddress || 'unknown').trim();
}

/**
 * 滑動視窗計數器。
 *
 * 與先前實作的關鍵差異：已經超限時**不再累加**。原本 push 在判斷之前，
 * 於是使用者每按一次登入都把冷卻往後推 5 分鐘 —— 越試越進不去。
 *
 * @returns {boolean} true 表示已超限、應拒絕
 */
function hit(bucket, key, { windowMs, max }) {
  const now = Date.now();
  const arr = (bucket.get(key) || []).filter((t) => now - t < windowMs);
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
  bucket.delete(key);
}

module.exports = { rateLimitEnabled, clientIp, hit, reset };

