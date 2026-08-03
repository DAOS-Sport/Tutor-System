-- Migration 038: 時段供給（slotSupply）— 家教預約改為「預設全開，教練自己關」
--
-- 現況問題：時段必須由教練逐筆建立才存在（POST /api/slots、/batch，且只有教練能用）。
--   教練沒排班 = 家長端一片空白，實務上大量家長卡在「教練沒去開課」。
--   注意：status 本來就預設 'available'，所以問題從來不是「沒開啟」，是「沒建立」。
--
-- 本 migration 只加表與欄位，不改任何既有資料或既有語意。
-- Idempotent — 與 server/bootstrap/coreSchema.js 保持一致；可在 prod 重跑。
-- Run: psql $DATABASE_URL -f db/migrations/038_slot_supply.sql

-- ① 場館營業時間：時段產生的唯一時間來源。由系統管理員／場館主管設定。
CREATE TABLE IF NOT EXISTS venue_business_hours (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id     VARCHAR(10) NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  weekday      SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0=週日
  open_time    TIME NOT NULL,
  close_time   TIME NOT NULL,
  slot_minutes INTEGER NOT NULL DEFAULT 60 CHECK (slot_minutes > 0),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (close_time > open_time),
  UNIQUE (venue_id, weekday, open_time)
);
CREATE INDEX IF NOT EXISTS idx_vbh_venue ON venue_business_hours(venue_id) WHERE is_active;

-- ② 時段來源標記。這是安全邊界，不是分類美學：
--    產生器重跑／rollback 時只能碰 generated_by='auto' 且 status='available' 的列，
--    絕不能刪教練手建的（NULL）、已被預約的（booked）、或教練刻意關閉的（blocked）。
ALTER TABLE coach_availability_slots ADD COLUMN IF NOT EXISTS generated_by TEXT;
CREATE INDEX IF NOT EXISTS idx_slots_generated
  ON coach_availability_slots(generated_by, status) WHERE generated_by IS NOT NULL;

-- ③ 首次預約提示：每個課期跳一次「請先與教練確認時間」。
--    刻意放在 enrollments 而非 parents——同一位家長的不同課期要各自提示一次。
ALTER TABLE course_period_enrollments
  ADD COLUMN IF NOT EXISTS booking_notice_ack_at TIMESTAMPTZ;