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

-- MGM 獎勵券持有者綁定（NULL = 公開券）
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS eligible_parent_id UUID REFERENCES parents(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_promotions_eligible_parent
  ON promotions(eligible_parent_id) WHERE eligible_parent_id IS NOT NULL;

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

-- Upgrade the v1 referral_records shape created by 001_initial_schema.sql.
-- Preserve the legacy columns because older reports still read them; the new
-- columns are backfilled deterministically before their constraints are added.
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS token VARCHAR(40);
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS coach_id UUID;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS experience_enrollment_id TEXT;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS trial_paid_at TIMESTAMPTZ;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ;
DO $$ BEGIN
  UPDATE referral_records
     SET token = COALESCE(token, referral_code, id::text),
         coach_id = COALESCE(coach_id, referred_coach_id),
         checked_in_at = COALESCE(checked_in_at, experience_completed_at);
EXCEPTION WHEN undefined_column THEN
  UPDATE referral_records SET token = COALESCE(token, id::text);
END $$;
ALTER TABLE referral_records ALTER COLUMN token SET NOT NULL;
ALTER TABLE referral_records ALTER COLUMN coach_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE referral_records ADD CONSTRAINT uq_referral_records_token UNIQUE (token);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE referral_records ADD CONSTRAINT fk_referral_records_coach
    FOREIGN KEY (coach_id) REFERENCES coaches(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The v1 enum cannot represent the v2 workflow states (trial_paid/checked_in).
-- VARCHAR retains old values and permits the new workflow without rewriting
-- or deleting historical referrals.
DO $$ BEGIN
  ALTER TABLE referral_records ALTER COLUMN status DROP DEFAULT;
  ALTER TABLE referral_records ALTER COLUMN status TYPE VARCHAR(30) USING status::text;
  ALTER TABLE referral_records ALTER COLUMN status SET DEFAULT 'pending';
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- 防刷：同一手機號碼只能被同一教練推薦一次（NULL referee_phone 不算）
CREATE UNIQUE INDEX IF NOT EXISTS uq_referrals_referee_coach
  ON referral_records(referee_phone, coach_id) WHERE referee_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referral_records(referrer_parent_id);
CREATE INDEX IF NOT EXISTS idx_referrals_coach ON referral_records(coach_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referral_records(status);

-- （已停用 2026-07）體驗課 5 折 TRIAL50 seed 已移除：全站優惠活動清除 + 停用推薦折扣。
-- 此檔頭標示「可在 prod 重跑」，故一併註解掉此 seed，避免手動重跑 migration 又把 TRIAL50 種回。
-- 若日後要恢復推薦體驗課折扣，重新啟用下方 INSERT，並同步恢復 coreSchema.js 的 seed、
-- RegisterPage.jsx 的 pendingCoupon 寫入與 enrollments.js 的 TRIAL50 驗證。
-- INSERT INTO promotions
--   (name, description, type, discount_value, applicable_course_types,
--    coupon_code, start_date, end_date, status, created_at, updated_at)
-- SELECT 'MGM 體驗課 5 折', '推薦連結專用：新客戶體驗課 5 折', 'PERCENTAGE', 0.5,
--        ARRAY[1,2,3], 'TRIAL50', CURRENT_DATE - INTERVAL '1 day',
--        CURRENT_DATE + INTERVAL '5 years', 'active', NOW(), NOW()
-- WHERE NOT EXISTS (SELECT 1 FROM promotions WHERE coupon_code = 'TRIAL50');
