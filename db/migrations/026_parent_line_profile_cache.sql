-- LINE display-name cache for admin enrollment details.
-- Kept separate from parents so identity fast-path never mutates canonical
-- parent data and LINE UID remains an authentication key, not a display value.

CREATE TABLE IF NOT EXISTS parent_line_profiles (
  line_uid VARCHAR(100) PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL DEFAULT '',
  source VARCHAR(30) NOT NULL,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

