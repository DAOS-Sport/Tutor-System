-- 044: 課程需求 x 教練加成級距的明價
--
-- 背景：系統原本一律用 base_price x coaches.pricing_multiplier 算單期單生價，
-- 但公司實際定價並非等比 —— 例如一對一 50% 級距，公司定價 9,000 而非 6,900x1.5=10,350。
-- 此欄位讓後台可對「特定課別 x 特定級距」落定明價，並走既有的編輯軌跡與排程生效機制。
--
-- 形如 {"1.20": 8280, "1.50": 9000}，key = pricing_multiplier 的兩位小數字串。
-- 未列出的級距 → 沿用 base_price x 加成（既有行為，不受影響）。
-- 唯一計算來源：server/services/coursePricing.js resolveUnitPrice()
ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS tier_prices JSONB;