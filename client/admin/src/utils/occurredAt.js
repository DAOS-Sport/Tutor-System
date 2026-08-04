/**
 * 手動扣課「壓時間」欄位的純邏輯（datetime-local ↔ ISO）。
 *
 * 抽出來是因為這段有兩個容易寫錯的地方，而且錯了不會當場報錯：
 *  1. <input type="datetime-local"> 的值沒有時區，`new Date('2026-08-01T14:30')`
 *     會被當成瀏覽器本地時間。櫃檯電腦就在台灣，這是對的；但要明確寫下來，
 *     否則之後有人「順手」加個 Z 就整批偏 8 小時。
 *  2. 未來時間必須擋。補登是記錄「已經上過的課」，填到未來會產生一堂
 *     completed 卻還沒發生的課，報表與剩餘堂數立刻失真。
 */

/** 把 Date 轉成 <input type="datetime-local"> 能吃的本地時間字串。 */
export function toLocalInputValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * @param {string} value  datetime-local 的原始值（'' 代表未指定）
 * @param {Date}   now
 * @returns {{ iso: string|null, error: string|null }}
 *          iso 為 null 代表「不要送 occurred_at」，維持伺服器接收時間語意。
 */
export function parseOccurredAt(value, now = new Date()) {
  const raw = String(value || '').trim();
  if (!raw) return { iso: null, error: null };
  // 不附加時區：datetime-local 沒有時區資訊，一律以櫃檯電腦的本地時間解讀。
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { iso: null, error: '上課時間格式不正確' };
  if (d.getTime() > now.getTime()) {
    return { iso: null, error: '上課時間不能填未來——補登是記錄已經上過的課' };
  }
  return { iso: d.toISOString(), error: null };
}