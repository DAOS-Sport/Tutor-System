/**
 * 單期單生價 —— 前端共用版（client/admin 與 client/liff 都用這一份）。
 *
 * 這是 server/services/coursePricing.js 的鏡射。之所以要有兩份：畫面上的價格是前端算的、
 * 成交金額是後端算的，兩邊不一致就是「看到 10,350、實際收 9,000」這種客訴。
 * 跨 client/server 邊界無法共用模組，只能鏡射 —— 因此 tests/course_tier_price_test.js
 * 會同時載入兩份實作、對同一組案例比對輸出，任一邊改了規則另一邊沒跟上，測試就會紅。
 *
 * 規則：課別對某個教練加成級距若有設定明價（課程需求管理的 tier_prices）就用明價，
 * 否則 base_price × 加成倍率。
 */

// 1.5 / '1.50' / 1.500 → '1.50'；無法解析 → '1.00'
export function tierKey(multiplier) {
  const n = Number(multiplier);
  return (Number.isFinite(n) && n > 0 ? n : 1).toFixed(2);
}

// 有明價回 number，沒有回 null。0 是合法明價（免費），不可當成「未設定」。
export function explicitTierPrice(tierPrices, multiplier) {
  if (!tierPrices || typeof tierPrices !== 'object') return null;
  const want = tierKey(multiplier);
  for (const [k, v] of Object.entries(tierPrices)) {
    if (tierKey(k) !== want) continue;
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n);
  }
  return null;
}

export function resolveUnitPrice(basePrice, multiplier, tierPrices) {
  const explicit = explicitTierPrice(tierPrices, multiplier);
  if (explicit !== null) return explicit;
  return Math.round((Number(basePrice) || 0) * (Number(multiplier) || 1));
}

// A missing coefficient is unknown, not the standard tier.
export function resolvePricingMultiplier(primary, alternate) {
  const raw = primary ?? alternate;
  if (raw == null || String(raw).trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function resolveCurrentUnitPrice(basePrice, multiplier, tierPrices) {
  if (basePrice == null || String(basePrice).trim() === '' || !Number.isFinite(Number(basePrice)) || Number(basePrice) < 0
      || resolvePricingMultiplier(multiplier) == null) return null;
  const value = resolveUnitPrice(basePrice, multiplier, tierPrices);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function hasCoursePeriodBounds(minimum, maximum) {
  return minimum != null && maximum != null
    && Number.isSafeInteger(Number(minimum)) && Number(minimum) > 0
    && Number.isSafeInteger(Number(maximum)) && Number(maximum) >= Number(minimum);
}

export function isCoursePeriodCount(value, minimum, maximum) {
  return hasCoursePeriodBounds(minimum, maximum) && Number.isSafeInteger(Number(value))
    && Number(value) >= Number(minimum) && Number(value) <= Number(maximum);
}

export function coursePeriodOptions(minimum, maximum) {
  if (!hasCoursePeriodBounds(minimum, maximum)) return [];
  return Array.from({ length: Number(maximum) - Number(minimum) + 1 }, (_, index) => Number(minimum) + index);
}

// New quotes require a venue's complete central pricing data; missing is not free.
export function hasCoursePricing(basePrice, sessionsPerPeriod) {
  return basePrice != null && String(basePrice).trim() !== ''
    && Number.isFinite(Number(basePrice)) && Number(basePrice) >= 0
    && Number.isSafeInteger(Number(sessionsPerPeriod)) && Number(sessionsPerPeriod) > 0;
}

// Explicit zero is a configured free trial. Only null/blank derives from the
// central per-period tier price and that pricing zone's sessions per period.
export function resolveTrialUnitPrice(basePrice, multiplier, tierPrices, trialPrice, sessionsPerPeriod) {
  if (!hasCoursePricing(basePrice, sessionsPerPeriod)) return null;
  const m = Number(multiplier);
  if (!Number.isFinite(m) || m <= 0) return null;
  if (trialPrice != null && String(trialPrice).trim() !== '') {
    const configured = Number(trialPrice);
    const value = Math.round(configured * m);
    return Number.isFinite(configured) && configured >= 0 && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const periodPrice = resolveCurrentUnitPrice(basePrice, m, tierPrices);
  if (periodPrice == null) return null;
  const value = Math.round(periodPrice / Number(sessionsPerPeriod));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}