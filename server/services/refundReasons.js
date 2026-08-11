'use strict';
/**
 * 退課申請原因 —— 後端版。
 *
 * 這是 client/shared/refundReasons.js 的鏡射。跨 client/server 邊界無法共用模組
 * （見 client/shared/coursePricing.js 的說明），但這份清單前後端都要用 ——
 * 前端畫下拉、後端驗證送進來的 code 在不在清單裡。兩邊分岔會出現
 * 「櫃檯選得到、送出被擋掉」。tests/refund_reason_parity_test.js 會同時載入
 * 兩份逐項比對，任一邊改了另一邊沒跟上就會紅。
 *
 * ⚠️ **code 一旦寫進 audit log 就不要再改**。要改顯示文字改 label。
 */
const REFUND_REASONS = [
  { code: 'company_no_coach', label: '公司因素 - 未媒合到教練' },
  { code: 'company_venue',    label: '公司因素 - 場地因素' },
  { code: 'personal_health',  label: '個人因素 - 生病/生理' },
  { code: 'personal_normal',  label: '個人因素 - 一般正常退費' },
  { code: 'other',            label: '其他' },
];

const REFUND_REASON_CODES = REFUND_REASONS.map((r) => r.code);

function refundReasonLabel(code) {
  const hit = REFUND_REASONS.find((r) => r.code === code);
  return hit ? hit.label : (code || '');
}

const REFUND_FEE_RATE_PRESETS = [0, 0.05, 0.1, 0.15, 0.2];

function normalizeFeeRatePercent(input) {
  if (input === '' || input === null || input === undefined) return null;
  const pct = Number(input);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return Math.round((pct / 100) * 10000) / 10000;
}

/**
 * 後端收到的 fee_rate 是 0–1 的比率（不是百分比）。
 * 回 null＝不合法或沒給，呼叫端應退回全域設定值。
 *
 * 夾限在 0–1：櫃檯手滑打成 110 的話寧可擋下來，也不要算出負的退款金額。
 */
function normalizeFeeRate(input) {
  if (input === '' || input === null || input === undefined) return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 10000) / 10000;
}

module.exports = {
  REFUND_REASONS,
  REFUND_REASON_CODES,
  refundReasonLabel,
  REFUND_FEE_RATE_PRESETS,
  normalizeFeeRatePercent,
  normalizeFeeRate,
};
