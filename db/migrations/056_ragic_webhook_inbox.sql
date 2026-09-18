CREATE TABLE IF NOT EXISTS ragic_webhook_inbox (
  sheet_code TEXT NOT NULL,
  ragic_record_id TEXT NOT NULL,
  event_type TEXT,
  revision BIGINT NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','retryable','completed','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  last_error_code TEXT,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sheet_code,ragic_record_id)
);
CREATE INDEX IF NOT EXISTS idx_ragic_webhook_inbox_pending
  ON ragic_webhook_inbox(next_retry_at) WHERE state IN ('pending','retryable');

-- Existing Z02 tables created before Z01 gained these fields do not inherit
-- later ALTERs through LIKE; add the projection metadata explicitly.
ALTER TABLE IF EXISTS ragic_z02_shadow ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS ragic_z02_shadow ADD COLUMN IF NOT EXISTS missing_since TIMESTAMPTZ;
ALTER TABLE IF EXISTS ragic_z02_shadow ADD COLUMN IF NOT EXISTS present_in_latest_pull BOOLEAN NOT NULL DEFAULT TRUE;
