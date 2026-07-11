-- 018_promotion_coach_multipliers_home.sql
-- 優惠新增兩個篩選：
--   1) applicable_coach_multipliers：限定套用在特定教練加成％（存 coaches.pricing_multiplier 值，如 1.30）。
--      NULL / 空陣列 = 不限教練加成（沿用 applicable_course_types / applicable_venue_ids 語意）。
--   2) show_on_parent_home：是否顯示在家長首頁的開關（預設 TRUE，維持既有優惠行為不變）。
-- Idempotent — 與 server/bootstrap/coreSchema.js 保持一致；可在 prod 重跑。

ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS applicable_coach_multipliers NUMERIC(5,2)[],
  ADD COLUMN IF NOT EXISTS show_on_parent_home BOOLEAN NOT NULL DEFAULT TRUE;
