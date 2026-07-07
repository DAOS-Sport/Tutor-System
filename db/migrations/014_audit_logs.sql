-- 014_audit_logs.sql
-- Generic critical/admin audit trail for destructive operations such as Staff Hard Delete.
-- Idempotent because db/migrate.js reruns all migrations in lexical order.

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  admin_id TEXT,
  target_type TEXT,
  target_ids TEXT[] NOT NULL DEFAULT '{}',
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS admin_id TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_at ON audit_logs(action, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity_at ON audit_logs(severity, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_at ON audit_logs(admin_id, at DESC);
