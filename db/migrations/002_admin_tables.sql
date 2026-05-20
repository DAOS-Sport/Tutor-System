-- Migration 002: Admin Phase 3 後台用簡化表
-- 與 client/admin/src/api/mock.js 對應；獨立於 v2 schema 以便先行落地。
-- Run: psql $DATABASE_URL -f db/migrations/002_admin_tables.sql

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','staff')),
  venue_id TEXT,
  line_uid VARCHAR(100) UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 已存在環境的安全升級（向前相容）：補 line_uid 欄位 → 主管收關鍵字警示 Flex
DO $$ BEGIN
  ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS line_uid VARCHAR(100) UNIQUE;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS admin_venues (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  line_token TEXT,
  bank_institution_name TEXT,
  bank_branch_name TEXT,
  account_holder TEXT,
  account_number TEXT,
  ragic_record_id TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','staff','coach')),
  venue_id TEXT,
  phone TEXT,
  is_senior BOOLEAN NOT NULL DEFAULT FALSE,
  multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.00,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  ragic_record_id TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Task #90：員工 ↔ 多場館（沿用 coach_venues 模式）
-- 舊 admin_staff.venue_id / admin_users.venue_id 暫時保留作 read-only fallback，
-- bootstrap 會把既有單筆 venue_id 一次性 backfill 到此中間表。
CREATE TABLE IF NOT EXISTS admin_staff_venues (
  staff_id TEXT NOT NULL REFERENCES admin_staff(id) ON DELETE CASCADE,
  venue_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (staff_id, venue_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_staff_venues_venue ON admin_staff_venues(venue_id);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_course_intros (
  course_type INT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_enrollments (
  id TEXT PRIMARY KEY,
  parent_name TEXT NOT NULL,
  parent_phone TEXT NOT NULL,
  students TEXT[] NOT NULL,
  coach TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  course_type INT NOT NULL,
  original_price NUMERIC(10,2) NOT NULL,
  final_price NUMERIC(10,2) NOT NULL,
  transfer_last_5 TEXT,
  status TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  total_sessions INT,
  used_sessions INT,
  refund_amount NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_enrollments_status ON admin_enrollments(status);
CREATE INDEX IF NOT EXISTS idx_admin_enrollments_venue ON admin_enrollments(venue_id);

CREATE TABLE IF NOT EXISTS admin_enrollment_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES admin_enrollments(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL,
  by_user TEXT NOT NULL,
  reason TEXT,
  refund_amount NUMERIC(10,2)
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_enrollment ON admin_enrollment_audit_logs(enrollment_id);

CREATE TABLE IF NOT EXISTS admin_today_sessions (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  coach TEXT NOT NULL,
  students TEXT[] NOT NULL,
  course_type INT NOT NULL,
  checkin_status TEXT NOT NULL DEFAULT 'not_yet',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_cancelled_sessions (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  start_time TEXT NOT NULL,
  period_id TEXT,
  parent_name TEXT NOT NULL,
  coach TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  refunded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
