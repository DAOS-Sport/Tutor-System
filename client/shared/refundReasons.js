/**
 * 退課申請原因 —— 前端共用版。
 *
 * 這是 server/services/refundReasons.js 的鏡射。之所以要有兩份：跨 client/server
 * 邊界無法共用模組（見同目錄 coursePricing.js 的說明），但這份清單前後端都要用 ——
 * 前端畫下拉、後端驗證送進來的 code 在不在清單裡。兩邊分岔的話會出現
 * 「櫃檯選得到、送出被擋掉」。因此 tests/refund_reason_parity_test.js 會同時
 * 載入兩份、逐項比對，任一邊改了另一邊沒跟上就會紅。
 *
 * ── 為什麼要有固定分類（Owner 2026-08-12 指定，對齊 Ragic 表單）──
 * 原本只有一格自由文字，每個櫃檯寫法都不同（「家長說要退」「搬家」「不想上了」），
 * 事後想統計「到底為什麼退」只能人工讀。分類讓它可彙總，詳述保留現場細節。
 *
 * ⚠️ **code 一旦寫進 audit log 就不要再改**。要改顯示文字改 label；
 *    改 code 會讓歷史紀錄變成對不上的孤兒分類。
 */
export const REFUND_REASONS = [
  { code: 'company_no_coach', label: '公司因素 - 未媒合到教練' },
  { code: 'company_venue',    label: '公司因素 - 場地因素' },
  { code: 'personal_health',  label: '個人因素 - 生病/生理' },
  { code: 'personal_normal',  label: '個人因素 - 一般正常退費' },
  { code: 'other',            label: '其他' },
];

export const REFUND_REASON_CODES = REFUND_REASONS.map((r) => r.code);

export function refundReasonLabel(code) {
  const hit = REFUND_REASONS.find((r) => r.code === code);
  return hit ? hit.label : (code || '');
}

/**
 * 手續費率下拉的預設值。**這不是上限** —— Owner 決定「下拉預設值＋可自填」，
 * 所以使用者仍可輸入清單以外的數字；偏離全域設定時由後端寫進 audit log。
 */
export const REFUND_FEE_RATE_PRESETS = [0, 0.05, 0.1, 0.15, 0.2];

/** 把使用者輸入的百分比字串正規化成 0–1 的比率；不合法回 null（呼叫端決定怎麼辦）。 */
export function normalizeFeeRatePercent(input) {
  if (input === '' || input === null || input === undefined) return null;
  const pct = Number(input);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  // 先四捨五入到小數第 4 位再回傳，避免 12.3 / 100 產生 0.12299999999999999
  return Math.round((pct / 100) * 10000) / 10000;
}
