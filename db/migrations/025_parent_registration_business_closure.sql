-- Parent registration business closure. Additive, audit-only support tables.
-- This migration never updates/deletes rights, source, parent, or student data.

CREATE TABLE IF NOT EXISTS parent_profile_patch_audit (
  id BIGSERIAL PRIMARY KEY,
  canonical_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  source_system TEXT NOT NULL DEFAULT 'RAGIC',
  source_table TEXT NOT NULL DEFAULT 'Z01',
  source_record_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  old_value_hash CHAR(64),
  new_value_hash CHAR(64) NOT NULL,
  change_reason TEXT NOT NULL CHECK (change_reason IN ('FILL_BLANK','VERIFIED_CONTACT_UPDATE')),
  ownership_verified BOOLEAN NOT NULL DEFAULT FALSE,
  actor TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parent_profile_patch_audit_parent_created
  ON parent_profile_patch_audit(canonical_parent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS parent_identity_backoffice_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_parent_id UUID REFERENCES parents(id) ON DELETE RESTRICT,
  masked_parent JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_record_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reason_code TEXT NOT NULL,
  suggested_action TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  rights_protection_status TEXT NOT NULL DEFAULT 'NO_RIGHTS_MUTATION',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','DISMISSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(correlation_id, reason_code)
);
CREATE INDEX IF NOT EXISTS idx_parent_identity_backoffice_open
  ON parent_identity_backoffice_tasks(status, created_at)
  WHERE status IN ('OPEN','IN_REVIEW');
