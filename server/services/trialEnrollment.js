/**
 * 試上單次課的共用資料契約。
 *
 * 一般報名的價格仍是「每期」；試上明確標記為 order_kind=trial，以「每人每堂」
 * 計價。2026-07-16 起開放多學員 × 多堂：一張試上訂單依「學員 × 堂數」拆分
 * 子訂單，每筆＝1 學員 1 堂（total_sessions=1），對帳後各自開通獨立體驗課期。
 * 若營運端設定了 `trial_price` 或 `trial_price_course_<N>`，會優先使用該值；
 * 未設定時才以既有每期價格除以 sessions_per_period 計算，避免把任意前端金額
 * 當成權威值。
 */
const ORDER_KIND = Object.freeze({
  STANDARD: 'standard',
  TRIAL: 'trial',
});

const PAYMENT_METHOD = Object.freeze({
  BANK_TRANSFER: 'bank_transfer',
  ON_SITE: 'on_site',
});

function normalizeOrderKind(value) {
  return String(value || '').trim().toLowerCase() === ORDER_KIND.TRIAL
    ? ORDER_KIND.TRIAL
    : ORDER_KIND.STANDARD;
}

function normalizePaymentMethod(value, orderKind = ORDER_KIND.STANDARD) {
  // 試上一律現場付費（2026-07：移除試上轉帳選項）；一般報名維持轉帳。
  // 即使前端／API 傳入 bank_transfer，試上也強制成 on_site（後端為權威來源）。
  if (orderKind === ORDER_KIND.TRIAL) {
    return PAYMENT_METHOD.ON_SITE;
  }
  return PAYMENT_METHOD.BANK_TRANSFER;
}

function positiveMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function calculateTrialPrice({ basePrice, courseType, settings = {}, configTrialPrice = null } = {}) {
  // F-A07 為品項價格唯一來源：course_type_configs.trial_price 優先；
  // 未設定時退回舊 admin_settings 鍵（過渡相容），最後才以每期價推算。
  const fromConfig = positiveMoney(configTrialPrice);
  if (fromConfig) return fromConfig;

  const courseSpecific = positiveMoney(settings[`trial_price_course_${courseType}`]);
  const configured = courseSpecific || positiveMoney(settings.trial_price);
  if (configured) return configured;

  const perPeriod = positiveMoney(basePrice);
  const sessions = Math.max(1, Math.trunc(Number(settings.sessions_per_period) || 6));
  return perPeriod ? Math.round(perPeriod / sessions) : 0;
}

module.exports = {
  ORDER_KIND,
  PAYMENT_METHOD,
  normalizeOrderKind,
  normalizePaymentMethod,
  calculateTrialPrice,
};
