-- Migration 006: 優惠活動 + 折價券 + 套用紀錄 (Phase 6 上)
-- F-M07 / F-A05 / F-R05 / F-S02 補充
-- Idempotent — 與 server/bootstrap/coreSchema.js 保持一致；可在 prod 重跑。
-- Run: psql $DATABASE_URL -f db/migrations/006_promotions.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type VARCHAR(20) NOT NULL CHECK (type IN ('PERCENTAGE','FIXED_AMOUNT')),
  discount_value NUMERIC(10,4) NOT NULL,
  min_threshold_type VARCHAR(20) CHECK (min_threshold_type IN ('PERIOD_COUNT')),
  min_threshold_value INTEGER,
  applicable_course_types INTEGER[],
  applicable_venue_ids VARCHAR(10)[],
  coupon_code VARCHAR(40) UNIQUE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  max_uses INTEGER,
  current_uses INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_review','active','rejected','archived')),
  review_note TEXT,
  created_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_promotions_active_dates
  ON promotions(status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_promotions_coupon
  ON promotions(coupon_code) WHERE coupon_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS promotion_usages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE RESTRICT,
  parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  course_period_id UUID REFERENCES course_periods(id) ON DELETE CASCADE,
  original_price INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  final_price INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_promo_usages_promo ON promotion_usages(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promo_usages_parent ON promotion_usages(parent_id);

-- 連結 LIFF 報名單（admin_enrollments.id 為 TEXT，故不設 FK）
ALTER TABLE promotion_usages ADD COLUMN IF NOT EXISTS admin_enrollment_id TEXT;
CREATE INDEX IF NOT EXISTS idx_promo_usages_enrollment ON promotion_usages(admin_enrollment_id);

CREATE TABLE IF NOT EXISTS promotion_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL,
  by_user TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_promo_audit_promo ON promotion_audit_logs(promotion_id);
