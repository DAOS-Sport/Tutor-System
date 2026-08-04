/**
 * 單期單生價 —— 前端鏡射版。
 *
 * 這是 server/services/coursePricing.js 的鏡射。之所以要有兩份：家長在「選擇教練」
 * 與報名頁看到的價格是前端算的，成交金額是後端算的，兩邊不一致就是「看到 10,350、
 * 收 9,000」這種客訴。跨 client/server 邊界無法共用模組，只能鏡射 —— 因此
 * tests/course_tier_price_test.js 會同時載入兩份實作、對同一組案例比對輸出，
 * 任何一邊改了規則另一邊沒跟上，測試就會紅。
 *
 * 規則：課別對某個教練加成級距若有設明價就用明價，否則 base_price × 加成倍率。
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