-- 022_ragic_z01_z03_claim_closure.sql
--
-- Ragic Z01 -> local Z03 split and local-first claim closure.
-- Additive, idempotent, and non-destructive: no source, parent, student, Z03,
-- enrollment, order, payment, or attendance row is deleted by this migration.

ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS phone_canonical TEXT;
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS source_updated_raw TEXT;
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'PENDING_Z03';
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS canonical_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL;
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS canonical_student_id UUID REFERENCES students(id) ON DELETE SET NULL;
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS claim_state TEXT NOT NULL DEFAULT 'UNRESOLVED';
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS last_processed_at TIMESTAMPTZ;
ALTER TABLE ragic_z03_records
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

-- Deterministic metadata backfill only. The original Ragic phone remains in
-- ragic_z03_records.phone unchanged for audit/display.
UPDATE ragic_z03_records
   SET phone_canonical = CASE
     WHEN regexp_replace(COALESCE(phone, ''), '\D', '', 'g') LIKE '886%'
       THEN '0' || SUBSTRING(regexp_replace(COALESCE(phone, ''), '\D', '', 'g') FROM 4)
     ELSE regexp_replace(COALESCE(phone, ''), '\D', '', 'g')
   END
 WHERE COALESCE(phone_canonical, '') = ''
   AND COALESCE(phone, '') <> '';

CREATE INDEX IF NOT EXISTS idx_ragic_z03_phone_canonical_status
  ON ragic_z03_records(phone_canonical, status);
CREATE INDEX IF NOT EXISTS idx_ragic_z03_source_updated
  ON ragic_z03_records(source_updated_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS identity_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose TEXT NOT NULL,
  state TEXT NOT NULL,
  phone_canonical TEXT NOT NULL,
  student_name_normalized TEXT NOT NULL,
  canonical_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  canonical_student_id UUID REFERENCES students(id) ON DELETE SET NULL,
  line_uid_hash CHAR(64),
  source_system TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  last_error_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  linked_at TIMESTAMPTZ,
  UNIQUE(purpose, source_system, source_table, source_record_id, student_name_normalized)
);
CREATE INDEX IF NOT EXISTS idx_identity_claims_state_updated
  ON identity_claims(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_identity_claims_phone
  ON identity_claims(phone_canonical);

CREATE TABLE IF NOT EXISTS source_record_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  canonical_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  canonical_student_id UUID REFERENCES students(id) ON DELETE RESTRICT,
  enrollment_id UUID,
  claim_id UUID REFERENCES identity_claims(id) ON DELETE SET NULL,
  link_method TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_system, source_table, source_record_id)
);
CREATE INDEX IF NOT EXISTS idx_source_record_links_parent
  ON source_record_links(canonical_parent_id);
CREATE INDEX IF NOT EXISTS idx_source_record_links_student
  ON source_record_links(canonical_student_id)
  WHERE canonical_student_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS identity_claim_events (
  id BIGSERIAL PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES identity_claims(id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT,
  actor_type TEXT NOT NULL DEFAULT 'parent',
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_identity_claim_events_claim_created
  ON identity_claim_events(claim_id, created_at);

CREATE TABLE IF NOT EXISTS ragic_sync_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  claim_id UUID NOT NULL REFERENCES identity_claims(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  payload_reference JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code TEXT,
  sanitized_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  correlation_id UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ragic_sync_outbox_due
  ON ragic_sync_outbox(next_retry_at, created_at)
  WHERE state IN ('pending', 'retryable');
