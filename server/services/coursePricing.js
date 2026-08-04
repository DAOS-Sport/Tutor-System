/**
 * 單期單生價的唯一計算來源。
 *
 * 規則：課別可針對「教練加成級距」設定明價（course_type_configs.tier_prices）。
 *   有設定 → 用設定的明價
 *   沒設定 → base_price × pricing_multiplier（既有行為，不變）
 *
 * tier_prices 形如 { "1.20": 8500, "1.50": 10500 }。
 * key 一律是 pricing_multiplier 的兩位小數字串 —— DB 欄位是 NUMERIC(5,2)，
 * 但 JS 讀出來可能是 1.5 也可能是 "1.50"，直接當 key 會對不上，所以統一過 tierKey()。
 */

// 1.5 / "1.50" / 1.500 → "1.50"；無法解析 → "1.00"
function tierKey(multiplier) {
  const n = Number(multiplier);
  return (Number.isFinite(n) && n > 0 ? n : 1).toFixed(2);
}

// tier_prices 裡這個級距有沒有設明價？有回 number，沒有回 null。
// 0 是合法明價（免費），不能被當成「未設定」。
// key 兩邊都過 tierKey()：DB 裡若躺著手動塞的 "1.5" 也照樣查得到 ——
// 查不到會靜默回退舊公式、價格默默算錯，是最難發現的一種錯。
function explicitTierPrice(tierPrices, multiplier) {
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

// 單期單生價。tierPrices 可為 null/undefined（就是全部沿用舊公式）。
function resolveUnitPrice(basePrice, multiplier, tierPrices) {
  const explicit = explicitTierPrice(tierPrices, multiplier);
  if (explicit !== null) return explicit;
  return Math.round((Number(basePrice) || 0) * (Number(multiplier) || 1));
}

// 後台送上來的 tier_prices 正規化：只留下能解析成非負數的項，key 正規化成兩位小數。
// 空字串 / null / 非數字 → 直接丟掉該級距（＝未設定）。全空回 null（存 NULL 而不是 {}）。
function normalizeTierPrices(input) {
  if (input === null || input === undefined || input === '') return null;
  let obj = input;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch (_) { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    const mk = Number(k);
    if (!Number.isFinite(mk) || mk <= 0) continue;
    out[tierKey(mk)] = Math.round(n);
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { tierKey, explicitTierPrice, resolveUnitPrice, normalizeTierPrices };