/**
 * 試上單次課的共用資料契約。
 *
 * 一般報名的價格仍是「每期」；試上明確標記為 order_kind=trial，以「每人每堂」
 * 計價。2026-07-16 起開放多學員 × 多堂：一張試上訂單依「學員 × 堂數」拆分
 * 子訂單，每筆＝1 學員 1 堂（total_sessions=1），對帳後各自開通獨立體驗課期。
 * 中央 trial_price 明價（含免費 0）乘選定係數；NULL 才以中央 tier 單期價除以
 * 場館定價區 sessions_per_period 推算，不再使用 admin_settings 舊價格。
 *
 * 2026-09-07 規格改變（使用者決定）：試上價**要乘教練係數**。原本固定價不吃係數，
 * 家長看到「係數 120% / 試上 NT$1,200」會覺得金額不對。固定價與 admin_settings 舊鍵
 * 都乘的舊相容分支於 v7 移除；推算改由中央 raw base/tier/係數解析。前端 CoachCard /
 * useEnrollmentPricing 用同一條規則，畫面價＝成交價。
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

// v7: only course_type_configs and its venue zone determine new trial quotes.
// basePrice is the central raw base; tierPrices applies only to NULL-trial inference.
const { resolveTrialUnitPrice } = require('./coursePricing');
function calculateTrialPrice({ basePrice, configTrialPrice = null, multiplier, tierPrices, sessionsPerPeriod } = {}) {
  return resolveTrialUnitPrice({ basePrice, multiplier, tierPrices, trialPrice: configTrialPrice, sessionsPerPeriod });
}

module.exports = {
  ORDER_KIND,
  PAYMENT_METHOD,
  normalizeOrderKind,
  normalizePaymentMethod,
  calculateTrialPrice,
};
