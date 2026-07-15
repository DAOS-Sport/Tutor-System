-- PM 3–8 operational hardening. Additive only; no legacy payment/order rows are rewritten.

ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS archive_state TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS onsite_payment_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE';

DO $$ BEGIN
  ALTER TABLE checkout_sessions ADD CONSTRAINT chk_checkout_archive_state
    CHECK (archive_state IN ('ACTIVE','SYSTEM_CANCELLED','ARCHIVED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE checkout_sessions ADD CONSTRAINT chk_checkout_onsite_payment_status
    CHECK (onsite_payment_status IN ('NOT_APPLICABLE','PENDING_ONSITE_PAYMENT','PAID'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS onsite_payment_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id UUID NOT NULL REFERENCES checkout_sessions(checkout_id) ON DELETE RESTRICT,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  collected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(checkout_id)
);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  venue_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  line_response_code INTEGER,
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  last_error_code TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(event_name, ref_id, parent_id),
  CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
  ON notification_jobs(status, next_attempt_at) WHERE status IN ('PENDING','FAILED');

ALTER TABLE coaches
  ADD COLUMN IF NOT EXISTS system_key TEXT,
  ADD COLUMN IF NOT EXISTS system_managed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS visible BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS assignable BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS login_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS payroll_eligible BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS percentage_eligible BOOLEAN NOT NULL DEFAULT TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_coaches_system_key
  ON coaches(system_key) WHERE system_key IS NOT NULL;
