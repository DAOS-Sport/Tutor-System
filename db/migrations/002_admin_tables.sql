-- Migration 002: Admin Phase 3 後台用簡化表
-- 與 client/admin/src/api/mock.js 對應；獨立於 v2 schema 以便先行落地。
-- Run: psql $DATABASE_URL -f db/migrations/002_admin_tables.sql

-- Task #51 5A-6：admin_users CREATE TABLE 已移除。
-- admin_users 在 step 1 已 1-shot 遷入 employees 表（roles[] 取代 role；email 取代 username；
-- password_hash + line_uid 一併搬走），routes/services/cron/middlewares/bootstrap 全改 employees。
-- 此處留空保留歷史脈絡；任何想 fresh provision 的環境，admin/manager/staff 帳號由
-- server/bootstrap/admin.js 的 seedIfEmpty() 直接 INSERT INTO employees。

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

-- Task #51 5A-6：admin_staff CREATE TABLE 已移除。
-- 教練於 step 1 一次性遷入 employees with roles=['coach']；非教練（manager/counter）
-- 由 employees admin seed + Ragic sync 維護，不再需要 admin_staff legacy 表。

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
