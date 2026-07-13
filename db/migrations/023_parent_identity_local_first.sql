-- Parent identity local-first closure. Additive and rights-safe: this migration
-- never updates/deletes enrollment, entitlement, order, payment or attendance.

ALTER TABLE ragic_z01_shadow
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE ragic_z01_shadow
  ADD COLUMN IF NOT EXISTS missing_since TIMESTAMPTZ;
ALTER TABLE ragic_z01_shadow
  ADD COLUMN IF NOT EXISTS present_in_latest_pull BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE ragic_z01_shadow
   SET last_seen_at = COALESCE(last_seen_at, fetched_at),
       present_in_latest_pull = COALESCE(present_in_latest_pull, TRUE);
CREATE INDEX IF NOT EXISTS idx_ragic_z01_shadow_presence
  ON ragic_z01_shadow(present_in_latest_pull, missing_since);

ALTER TABLE ragic_z03_students
  ADD COLUMN IF NOT EXISTS source_row_key TEXT;
ALTER TABLE ragic_z03_students
  ADD COLUMN IF NOT EXISTS name_normalized TEXT;
ALTER TABLE ragic_z03_students
  ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'VALID';
ALTER TABLE ragic_z03_students
  ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE ragic_z03_students
  ADD COLUMN IF NOT EXISTS present_in_latest_payload BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ragic_z03_students
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE ragic_z03_students
   SET source_row_key = 'legacy:' || id::text
 WHERE source_row_key IS NULL OR source_row_key = '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ragic_z03_student_source_row
  ON ragic_z03_students(z03_record_id, source_row_key);

ALTER TABLE ragic_sync_outbox
  ADD COLUMN IF NOT EXISTS target_record_id TEXT;
ALTER TABLE ragic_sync_outbox
  ADD COLUMN IF NOT EXISTS field_id TEXT;

CREATE TABLE IF NOT EXISTS parent_identity_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL,
  line_uid_hash CHAR(64) NOT NULL,
  operation TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  canonical_parent_id UUID REFERENCES parents(id) ON DELETE RESTRICT,
  canonical_student_id UUID REFERENCES students(id) ON DELETE RESTRICT,
  claim_id UUID REFERENCES identity_claims(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(line_uid_hash, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS parent_line_uid_rebind_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  old_uid_hash CHAR(64) NOT NULL,
  new_uid_hash CHAR(64) NOT NULL,
  reason_code TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Guard against two active claims for one Ragic source. Existing conflicts are
-- preserved for review; the index is installed only when the data is clean.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity_claims
     WHERE state NOT IN ('SYNCED', 'MANUAL_REVIEW', 'SYNC_BLOCKED_SCHEMA', 'SYNC_BLOCKED_DATA_CONFLICT')
     GROUP BY source_system, source_table, source_record_id HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_claims_active_source
      ON identity_claims(source_system, source_table, source_record_id)
      WHERE state NOT IN ('SYNCED', 'MANUAL_REVIEW', 'SYNC_BLOCKED_SCHEMA', 'SYNC_BLOCKED_DATA_CONFLICT');
  END IF;
END $$;
