-- Shared entitlement / usage reversal v2 (additive only).
-- course_periods remains the entitlement; course_sessions remains the usage event;
-- checkin_records remains per-student attendance. No parallel rights tables are created.

ALTER TABLE course_periods
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
