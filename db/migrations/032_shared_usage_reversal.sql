-- Shared lesson usage and additive reversal metadata.
-- course_periods is the entitlement, course_sessions is one lesson usage event,
-- and checkin_records contains the per-student attendance rows for that event.

ALTER TABLE course_periods
  ADD COLUMN IF NOT EXISTS admin_enrollment_id TEXT,
  ADD COLUMN IF NOT EXISTS group_order_id UUID,
  ADD COLUMN IF NOT EXISTS enrollment_batch_id UUID,
  ADD COLUMN IF NOT EXISTS period_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS entitlement_state TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS superseded_by_course_period_id UUID REFERENCES course_periods(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by TEXT,
  ADD COLUMN IF NOT EXISTS superseded_reason TEXT;

DO $$ BEGIN
  ALTER TABLE course_periods ADD CONSTRAINT chk_course_periods_entitlement_state
    CHECK (entitlement_state IN ('ACTIVE','SUPERSEDED','MANUAL_REVIEW'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_course_periods_entitlement_state
  ON course_periods(entitlement_state, created_at DESC);

-- Reversal updates every enrollment sharing the entitlement. These carrier
-- columns existed in bootstrap before they were guaranteed by SQL migrations.
ALTER TABLE admin_enrollments
  ADD COLUMN IF NOT EXISTS group_order_id UUID,
  ADD COLUMN IF NOT EXISTS enrollment_batch_id UUID,
  ADD COLUMN IF NOT EXISTS period_number INTEGER NOT NULL DEFAULT 1;

ALTER TABLE course_sessions
  ADD COLUMN IF NOT EXISTS session_deducted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE manual_lesson_deductions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'APPLIED',
  ADD COLUMN IF NOT EXISTS reversed_by TEXT,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE manual_lesson_deductions ADD CONSTRAINT chk_manual_deduction_status
    CHECK (status IN ('APPLIED','REVERSED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_manual_deductions_status_created
  ON manual_lesson_deductions(status, created_at DESC);

ALTER TABLE checkin_records
  ADD COLUMN IF NOT EXISTS attendance_status TEXT NOT NULL DEFAULT 'ATTENDED',
  ADD COLUMN IF NOT EXISTS reversed_by TEXT,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE checkin_records ADD CONSTRAINT chk_checkin_attendance_status
    CHECK (attendance_status IN ('ATTENDED','REVERSED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_checkin_records_attendance_status
  ON checkin_records(course_session_id, attendance_status);

CREATE TABLE IF NOT EXISTS lesson_deduction_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_session_id UUID NOT NULL REFERENCES course_sessions(id) ON DELETE RESTRICT,
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  reversed_by TEXT NOT NULL,
  reversed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_session_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_deduction_reversals_period
  ON lesson_deduction_reversals(course_period_id, reversed_at DESC);

CREATE TABLE IF NOT EXISTS application_feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_phones TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO application_feature_flags (key, enabled, allowed_phones)
VALUES
  ('SHARED_CHECKIN_USAGE_V2', TRUE, ARRAY['0982252694']::text[]),
  ('DEDUCTION_REVIVAL_V2', TRUE, ARRAY['0982252694']::text[])
ON CONFLICT (key) DO NOTHING;
