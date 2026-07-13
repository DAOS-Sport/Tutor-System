-- Release-candidate hardening for parent identity only.
-- Additive and non-destructive: no parent, student, source, enrollment, order,
-- payment, attendance, entitlement, or LINE UID value is deleted/cleared.

ALTER TABLE ragic_z03_students
  ADD COLUMN IF NOT EXISTS canonical_student_id UUID REFERENCES students(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ragic_z01_uid_schema_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fetched_at TIMESTAMPTZ NOT NULL,
  endpoint TEXT NOT NULL,
  sheet_path TEXT NOT NULL,
  sheet_id TEXT,
  http_status INTEGER NOT NULL,
  response_hash CHAR(64) NOT NULL,
  field_id TEXT NOT NULL,
  field_name TEXT,
  attr_no_dup BOOLEAN,
  attr_must BOOLEAN,
  attr_ro BOOLEAN,
  schema_version TEXT,
  schema_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID NOT NULL,
  verified BOOLEAN NOT NULL,
  failure_code TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ragic_z01_uid_schema_latest
  ON ragic_z01_uid_schema_verifications(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_ragic_z01_uid_schema_verified_expiry
  ON ragic_z01_uid_schema_verifications(verified, expires_at DESC);

CREATE TABLE IF NOT EXISTS ragic_source_identity_status (
  source_system TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('MERGED','INVALID_SOURCE','ARCHIVED','SUPERSEDED')),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  set_by TEXT NOT NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correlation_id UUID NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source_system, source_table, source_record_id)
);

CREATE TABLE IF NOT EXISTS ragic_source_identity_status_audit (
  id BIGSERIAL PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ragic_source_status_audit_source
  ON ragic_source_identity_status_audit(source_system, source_table, source_record_id, created_at);

CREATE TABLE IF NOT EXISTS parent_account_recovery_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key CHAR(64) NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'ACCOUNT_RECOVERY_REQUIRED','ACCOUNT_RECOVERY_VERIFYING','ACCOUNT_RECOVERY_VERIFIED',
    'ACCOUNT_REBIND_PENDING','ACCOUNT_REBOUND','ACCOUNT_RECOVERY_FAILED','ACCOUNT_RECOVERY_LOCKED'
  )),
  canonical_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  canonical_student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  claim_id UUID REFERENCES identity_claims(id) ON DELETE SET NULL,
  ragic_record_id TEXT NOT NULL,
  phone_canonical TEXT NOT NULL,
  student_name_normalized TEXT NOT NULL,
  old_uid_hash CHAR(64) NOT NULL,
  ragic_old_uid_hash CHAR(64) NOT NULL,
  new_uid_hash CHAR(64) NOT NULL,
  requested_line_uid TEXT NOT NULL,
  recovery_token_hash CHAR(64) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  initiated_by TEXT NOT NULL,
  approved_by TEXT,
  verification_method TEXT,
  verification_reference TEXT,
  reason TEXT,
  correlation_id UUID NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verifying_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  ragic_sync_state TEXT NOT NULL DEFAULT 'NOT_QUEUED',
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parent_recovery_parent_state
  ON parent_account_recovery_requests(canonical_parent_id, state, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_parent_recovery_active_parent
  ON parent_account_recovery_requests(canonical_parent_id)
  WHERE state IN ('ACCOUNT_RECOVERY_REQUIRED','ACCOUNT_RECOVERY_VERIFYING',
                  'ACCOUNT_RECOVERY_VERIFIED','ACCOUNT_REBIND_PENDING');

CREATE TABLE IF NOT EXISTS parent_account_recovery_events (
  id BIGSERIAL PRIMARY KEY,
  recovery_request_id UUID NOT NULL REFERENCES parent_account_recovery_requests(id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT,
  actor TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parent_recovery_events_request
  ON parent_account_recovery_events(recovery_request_id, created_at);

CREATE TABLE IF NOT EXISTS parent_line_uid_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  uid_hash CHAR(64) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED','REPLACED')),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  replaced_by_uid_hash CHAR(64),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_parent_line_uid_binding_active_uid
  ON parent_line_uid_bindings(uid_hash) WHERE status='ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_parent_line_uid_binding_active_parent
  ON parent_line_uid_bindings(canonical_parent_id) WHERE status='ACTIVE';

INSERT INTO parent_line_uid_bindings
  (canonical_parent_id, uid_hash, status, correlation_id)
SELECT p.id, encode(digest(p.line_uid, 'sha256'), 'hex'), 'ACTIVE', gen_random_uuid()
  FROM parents p
 WHERE p.is_active=TRUE AND COALESCE(p.line_uid,'')<>''
ON CONFLICT DO NOTHING;

ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS ragic_record_id TEXT;
ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS recovery_request_id UUID REFERENCES parent_account_recovery_requests(id) ON DELETE RESTRICT;
ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS verification_method TEXT;
ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS verification_reference TEXT;
ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS initiated_by TEXT;
ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ;
ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;
ALTER TABLE parent_line_uid_rebind_audit
  ADD COLUMN IF NOT EXISTS ragic_sync_state TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_parent_line_uid_rebind_request
  ON parent_line_uid_rebind_audit(recovery_request_id)
  WHERE recovery_request_id IS NOT NULL;
