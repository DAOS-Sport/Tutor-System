-- Migration 007: MGM 推薦裂變 (Phase 6 下)
-- F-S10 / F-M10
-- Idempotent — 與 server/bootstrap/coreSchema.js 保持一致；可在 prod 重跑。
-- Run: psql $DATABASE_URL -f db/migrations/007_referrals.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 補齊家長 / 學員的可選欄位（LIFF RegisterPage 用）
ALTER TABLE parents  ADD COLUMN IF NOT EXISTS email   VARCHAR(255);
ALTER TABLE parents  ADD COLUMN IF NOT EXISTS gender  VARCHAR(20);
ALTER TABLE students ADD COLUMN IF NOT EXISTS id_number VARCHAR(20);
ALTER TABLE students ADD COLUMN IF NOT EXISTS gender    VARCHAR(20);

CREATE TABLE IF NOT EXISTS referral_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token VARCHAR(40) NOT NULL UNIQUE,
  referrer_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  referee_phone VARCHAR(20),
  referee_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','registered','trial_paid','checked_in','reward_issued')),
  experience_enrollment_id TEXT,
  reward_promotion_id UUID REFERENCES promotions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registered_at TIMESTAMPTZ,
  trial_paid_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  reward_issued_at TIMESTAMPTZ
);

-- 防刷：同一手機號碼只能被同一教練推薦一次（NULL referee_phone 不算）
CREATE UNIQUE INDEX IF NOT EXISTS uq_referrals_referee_coach
  ON referral_records(referee_phone, coach_id) WHERE referee_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referral_records(referrer_parent_id);
CREATE INDEX IF NOT EXISTS idx_referrals_coach ON referral_records(coach_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referral_records(status);

-- 體驗課 5 折優惠 seed（cooupon_code = TRIAL50；發放後僅在後端
-- /api/enrollments 內額外驗證該家長是否有 referral_records 對應紀錄）
INSERT INTO promotions
  (name, description, type, discount_value, applicable_course_types,
   coupon_code, start_date, end_date, status, created_at, updated_at)
SELECT 'MGM 體驗課 5 折', '推薦連結專用：新客戶體驗課 5 折', 'PERCENTAGE', 0.5,
       ARRAY[1,2,3], 'TRIAL50', CURRENT_DATE - INTERVAL '1 day',
       CURRENT_DATE + INTERVAL '5 years', 'active', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM promotions WHERE coupon_code = 'TRIAL50');
