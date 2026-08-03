-- Migration 037: 團購套用優惠代碼 — U14
-- 現況：server/routes/groupOrders.js 與 admin/groupOrders.js 都沒有 require promotions，
--   核准時 original_price = final_price，結構上沒有折扣空間。
--
-- 設計要點（為什麼折扣必須「早於核准」就鎖定）：
--   團購金流是「先轉帳、後審核」——家長在 forming 階段就照狀態頁顯示的 amount_due 轉帳。
--   若折扣等到 approve 才算，家長早已按原價轉完帳。故：
--     發起團購時鎖定促銷快照 → 每家加入時依快照算「該家」折扣並落地金額 → 核准時直接沿用。
--   折扣「每家獨立計算」而非「折總額再攤分」：攤分的分母（總學生數）會隨新成員加入而變動，
--   會改到已轉帳家庭的金額。各家 amount_due 本來就互相獨立，折扣照樣獨立。
--
-- Idempotent — 與 server/bootstrap/coreSchema.js 保持一致；可在 prod 重跑。
-- Run: psql $DATABASE_URL -f db/migrations/037_group_order_promotion.sql

-- ① 促銷的「通路」開關。
--    預設 FALSE 是回歸防線：預設 TRUE 會讓現有所有促銷立刻套用到團購、改變定價。
--    要開放團購折扣，由管理員在促銷表單逐筆勾選。
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS applicable_to_group_orders BOOLEAN NOT NULL DEFAULT FALSE;

-- ② 團購鎖定的促銷快照（發起時寫入，之後不再重算）
ALTER TABLE group_orders
  ADD COLUMN IF NOT EXISTS promotion_id UUID REFERENCES promotions(id) ON DELETE SET NULL;
ALTER TABLE group_orders
  ADD COLUMN IF NOT EXISTS promotion_snapshot JSONB;

-- ③ 每家落地金額。
--    刻意 nullable：既有團購的 member 全為 NULL，shapeMember 以 COALESCE 退回原本的
--    動態計算，既有團的顯示金額行為完全不變；只有新團才吃落地值。
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS original_amount INTEGER;
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS discount_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS final_amount    INTEGER;

-- ④ promotion_usages 支援團購回沖。
--    revertUsage 原本只認 admin_enrollment_id，但團購在 forming 階段還沒有 admin_enrollments
--    （那是 approve 才建的）。任何早於 approve 的扣名額時點都需要這條回沖路徑。
ALTER TABLE promotion_usages
  ADD COLUMN IF NOT EXISTS group_order_id UUID REFERENCES group_orders(id) ON DELETE SET NULL;
ALTER TABLE promotion_usages
  ADD COLUMN IF NOT EXISTS group_order_member_id UUID;
CREATE INDEX IF NOT EXISTS idx_promo_usages_group
  ON promotion_usages(group_order_id) WHERE group_order_id IS NOT NULL;

-- ⑤ 同一個團購成員只會有一筆 usage（防重複扣名額；退出／退回清空後可重建）
CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_usages_group_member
  ON promotion_usages(group_order_member_id) WHERE group_order_member_id IS NOT NULL;
