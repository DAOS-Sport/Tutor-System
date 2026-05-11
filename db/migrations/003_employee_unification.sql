-- ============================================================================
-- Migration 003: Employee Unification
-- ============================================================================
-- 將 coaches / admin_users / admin_staff 三套身分系統合併為單一 employees 表
-- 採 roles TEXT[] 多角色設計（coach / counter / manager / system_admin）
-- 修正 17 個 FK 指向 employees(id)，重建 4 個依賴 coaches 的 view
--
-- 重要設計：
-- 1. employees.id = UUID。從 coaches 來的記錄沿用原 UUID（避免 coach FK 重新對應）
-- 2. 從 admin_users (VARCHAR id 'U001') 來的記錄分配新 UUID，使用臨時對應表
-- 3. 整個 migration 包在 transaction 內，失敗自動 rollback
-- 4. 多次執行：用 IF NOT EXISTS / IF EXISTS guard，已遷移過的環境會自動跳過
-- 5. 附件 spec 提到的 staff_roles / refund_records / payment_audit_logs /
--    course_intros 在當前 DB 不存在，本檔忽略
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. 建立 employees 表（含 intro_review_* 欄位以保留 F-C06 教練介紹送審功能）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ragic_employee_id   VARCHAR(50) UNIQUE,
  employee_number     VARCHAR(50) UNIQUE,
  name                VARCHAR(100) NOT NULL,
  phone               VARCHAR(20) UNIQUE,
  email               VARCHAR(255) UNIQUE,
  line_uid            VARCHAR(100) UNIQUE,
  password_hash       VARCHAR(255),
  roles               TEXT[] NOT NULL DEFAULT '{}',
  venue_id            VARCHAR(10) REFERENCES venues(id),
  is_senior           BOOLEAN NOT NULL DEFAULT FALSE,
  pricing_multiplier  DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  bio_rich_text       TEXT,
  specialties         TEXT[],
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  intro_review_status VARCHAR(20),
  intro_review_note   TEXT,
  intro_submitted_at  TIMESTAMPTZ,
  intro_reviewed_at   TIMESTAMPTZ,
  intro_reviewed_by   UUID,
  last_synced_at      TIMESTAMPTZ,
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_phone    ON employees(phone);
CREATE INDEX IF NOT EXISTS idx_employees_email    ON employees(email);
CREATE INDEX IF NOT EXISTS idx_employees_line_uid ON employees(line_uid);
CREATE INDEX IF NOT EXISTS idx_employees_roles    ON employees USING GIN(roles);
CREATE INDEX IF NOT EXISTS idx_employees_active   ON employees(is_active);

-- ----------------------------------------------------------------------------
-- 2. 從 coaches 灌資料 — 沿用原 UUID，roles=['coach']
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='coaches') THEN
    INSERT INTO employees (
      id, ragic_employee_id, name, phone, line_uid, email,
      roles, is_senior, pricing_multiplier, bio_rich_text, specialties,
      is_active, intro_review_status, intro_review_note,
      intro_submitted_at, intro_reviewed_at,
      created_at, updated_at
    )
    SELECT
      id, ragic_employee_id, name, phone, line_uid, email,
      ARRAY['coach']::TEXT[],
      is_senior, pricing_multiplier, bio_rich_text, specialties,
      is_active, intro_review_status, intro_review_note,
      intro_submitted_at, intro_reviewed_at,
      created_at, updated_at
    FROM coaches
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. admin_users → employees 對應
--    建立臨時對應表：admin_users.id (VARCHAR 'U001') → 新 UUID
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE IF NOT EXISTS _admin_user_id_map (
  old_id VARCHAR PRIMARY KEY,
  new_id UUID NOT NULL DEFAULT gen_random_uuid()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='admin_users') THEN
    -- 為每個 admin_user 預先決定一個 UUID（後面 backfill FK 時用）
    INSERT INTO _admin_user_id_map (old_id)
    SELECT id FROM admin_users
    ON CONFLICT (old_id) DO NOTHING;

    -- 3-A. 已存在的 employees（從 coaches 遷移過來、能透過 admin_staff.phone 對到 admin_user）
    --      → 把後台欄位（email/password_hash/venue_id）補上、roles 加上後台角色
    UPDATE employees e
    SET
      email = COALESCE(e.email, au.username),
      password_hash = COALESCE(e.password_hash, au.password_hash),
      venue_id = COALESCE(e.venue_id, au.venue_id),
      roles = ARRAY(
        SELECT DISTINCT r FROM unnest(e.roles || ARRAY[
          CASE au.role
            WHEN 'admin'   THEN 'system_admin'
            WHEN 'manager' THEN 'manager'
            WHEN 'staff'   THEN 'counter'
            ELSE au.role
          END
        ]::TEXT[]) AS r
      )
    FROM admin_users au
    JOIN admin_staff ast ON ast.id = au.id
    WHERE e.phone = ast.phone;

    -- 3-A 對應 employees 的 UUID 寫回 mapping，讓 FK backfill 可以用到正確的 employee UUID
    UPDATE _admin_user_id_map m
    SET new_id = e.id
    FROM admin_users au
    JOIN admin_staff ast ON ast.id = au.id
    JOIN employees e ON e.phone = ast.phone
    WHERE m.old_id = au.id;

    -- 3-B. 沒對應到 employees 的 admin_user → 新建 employee 記錄（用預配的 UUID）
    INSERT INTO employees (id, name, email, password_hash, roles, venue_id, is_active)
    SELECT
      m.new_id,
      au.name,
      au.username,
      au.password_hash,
      ARRAY[
        CASE au.role
          WHEN 'admin'   THEN 'system_admin'
          WHEN 'manager' THEN 'manager'
          WHEN 'staff'   THEN 'counter'
          ELSE au.role
        END
      ]::TEXT[],
      au.venue_id,
      TRUE
    FROM admin_users au
    JOIN _admin_user_id_map m ON m.old_id = au.id
    WHERE NOT EXISTS (
      SELECT 1 FROM employees e2
      JOIN admin_staff ast2 ON ast2.phone = e2.phone
      WHERE ast2.id = au.id
    )
    ON CONFLICT (email) DO NOTHING;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. 從 admin_staff 補 ragic_employee_id（若 employees 同手機已存在但無 Ragic ID）
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='admin_staff') THEN
    UPDATE employees e
    SET ragic_employee_id = ast.ragic_record_id
    FROM admin_staff ast
    WHERE e.phone = ast.phone
      AND ast.ragic_record_id IS NOT NULL
      AND e.ragic_employee_id IS NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5. DROP 4 個依賴 coaches 的 view（為了 RENAME coach_id → employee_id）
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_course_period_summary CASCADE;
DROP VIEW IF EXISTS v_coach_weekly_schedule CASCADE;
DROP VIEW IF EXISTS v_coach_evaluation_avg  CASCADE;
DROP VIEW IF EXISTS v_coach_available_slots CASCADE;

-- ----------------------------------------------------------------------------
-- 6. 11 個 coach_id 欄位 → employee_id（UUID 不變所以資料免轉，純 RENAME + 重綁 FK）
-- ----------------------------------------------------------------------------

-- 6-1. coach_bio_media.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='coach_bio_media' AND column_name='coach_id') THEN
    ALTER TABLE coach_bio_media DROP CONSTRAINT IF EXISTS coach_bio_media_coach_id_fkey;
    ALTER TABLE coach_bio_media RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE coach_bio_media ADD CONSTRAINT coach_bio_media_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 6-2. coach_availability_slots.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='coach_availability_slots' AND column_name='coach_id') THEN
    ALTER TABLE coach_availability_slots DROP CONSTRAINT IF EXISTS coach_availability_slots_coach_id_fkey;
    ALTER TABLE coach_availability_slots RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE coach_availability_slots ADD CONSTRAINT coach_availability_slots_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 6-3. coach_personal_tags.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='coach_personal_tags' AND column_name='coach_id') THEN
    ALTER TABLE coach_personal_tags DROP CONSTRAINT IF EXISTS coach_personal_tags_coach_id_fkey;
    ALTER TABLE coach_personal_tags RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE coach_personal_tags ADD CONSTRAINT coach_personal_tags_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 6-4. coach_venues.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='coach_venues' AND column_name='coach_id') THEN
    ALTER TABLE coach_venues DROP CONSTRAINT IF EXISTS coach_venues_coach_id_fkey;
    ALTER TABLE coach_venues RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE coach_venues ADD CONSTRAINT coach_venues_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 6-5. course_periods.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='course_periods' AND column_name='coach_id') THEN
    ALTER TABLE course_periods DROP CONSTRAINT IF EXISTS course_periods_coach_id_fkey;
    ALTER TABLE course_periods RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE course_periods ADD CONSTRAINT course_periods_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id);
  END IF;
END $$;

-- 6-6. session_records.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='session_records' AND column_name='coach_id') THEN
    ALTER TABLE session_records DROP CONSTRAINT IF EXISTS session_records_coach_id_fkey;
    ALTER TABLE session_records RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE session_records ADD CONSTRAINT session_records_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id);
  END IF;
END $$;

-- 6-7. session_record_versions.edited_by (UUID → UUID, 只重綁 FK 指向 employees)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='session_record_versions' AND column_name='edited_by') THEN
    ALTER TABLE session_record_versions DROP CONSTRAINT IF EXISTS session_record_versions_edited_by_fkey;
    ALTER TABLE session_record_versions ADD CONSTRAINT session_record_versions_edited_by_fkey
      FOREIGN KEY (edited_by) REFERENCES employees(id);
  END IF;
END $$;

-- 6-8. lesson_plans.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='lesson_plans' AND column_name='coach_id') THEN
    ALTER TABLE lesson_plans DROP CONSTRAINT IF EXISTS lesson_plans_coach_id_fkey;
    ALTER TABLE lesson_plans RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE lesson_plans ADD CONSTRAINT lesson_plans_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id);
  END IF;
END $$;

-- 6-9. course_evaluations.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='course_evaluations' AND column_name='coach_id') THEN
    ALTER TABLE course_evaluations DROP CONSTRAINT IF EXISTS course_evaluations_coach_id_fkey;
    ALTER TABLE course_evaluations RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE course_evaluations ADD CONSTRAINT course_evaluations_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id);
  END IF;
END $$;

-- 6-10. eval_threshold_alerts.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='eval_threshold_alerts' AND column_name='coach_id') THEN
    ALTER TABLE eval_threshold_alerts DROP CONSTRAINT IF EXISTS eval_threshold_alerts_coach_id_fkey;
    ALTER TABLE eval_threshold_alerts RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE eval_threshold_alerts ADD CONSTRAINT eval_threshold_alerts_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id);
  END IF;
END $$;

-- 6-11. referral_records.coach_id → employee_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='referral_records' AND column_name='coach_id') THEN
    ALTER TABLE referral_records DROP CONSTRAINT IF EXISTS referral_records_coach_id_fkey;
    ALTER TABLE referral_records RENAME COLUMN coach_id TO employee_id;
    ALTER TABLE referral_records ADD CONSTRAINT referral_records_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 7. admin_users FK 欄位（VARCHAR → UUID，需透過 _admin_user_id_map 轉換）
-- ----------------------------------------------------------------------------
-- Helper 模式：
--   ADD COLUMN <col>_new UUID
--   UPDATE … FROM mapping
--   DROP CONSTRAINT old / DROP COLUMN old / RENAME _new → 原名
--   ADD CONSTRAINT new FK → employees(id)

-- 7-1. promotions.created_by (VARCHAR → UUID)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='promotions' AND column_name='created_by'
               AND data_type IN ('character varying','text')) THEN
    ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_created_by_fkey;
    ALTER TABLE promotions ADD COLUMN IF NOT EXISTS created_by_new UUID;
    UPDATE promotions p SET created_by_new = m.new_id
      FROM _admin_user_id_map m WHERE m.old_id = p.created_by::text;
    ALTER TABLE promotions DROP COLUMN created_by;
    ALTER TABLE promotions RENAME COLUMN created_by_new TO created_by;
    ALTER TABLE promotions ADD CONSTRAINT promotions_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES employees(id);
  END IF;
END $$;

-- 7-2. promotions.reviewed_by (VARCHAR → UUID)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='promotions' AND column_name='reviewed_by'
               AND data_type IN ('character varying','text')) THEN
    ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_reviewed_by_fkey;
    ALTER TABLE promotions ADD COLUMN IF NOT EXISTS reviewed_by_new UUID;
    UPDATE promotions p SET reviewed_by_new = m.new_id
      FROM _admin_user_id_map m WHERE m.old_id = p.reviewed_by::text;
    ALTER TABLE promotions DROP COLUMN reviewed_by;
    ALTER TABLE promotions RENAME COLUMN reviewed_by_new TO reviewed_by;
    ALTER TABLE promotions ADD CONSTRAINT promotions_reviewed_by_fkey
      FOREIGN KEY (reviewed_by) REFERENCES employees(id);
  END IF;
END $$;

-- 7-3. promotion_audit_logs.by_user (VARCHAR → UUID)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='promotion_audit_logs' AND column_name='by_user'
               AND data_type IN ('character varying','text')) THEN
    ALTER TABLE promotion_audit_logs DROP CONSTRAINT IF EXISTS promotion_audit_logs_by_user_fkey;
    ALTER TABLE promotion_audit_logs ADD COLUMN IF NOT EXISTS by_user_new UUID;
    UPDATE promotion_audit_logs p SET by_user_new = m.new_id
      FROM _admin_user_id_map m WHERE m.old_id = p.by_user::text;
    ALTER TABLE promotion_audit_logs DROP COLUMN by_user;
    ALTER TABLE promotion_audit_logs RENAME COLUMN by_user_new TO by_user;
    ALTER TABLE promotion_audit_logs ADD CONSTRAINT promotion_audit_logs_by_user_fkey
      FOREIGN KEY (by_user) REFERENCES employees(id);
  END IF;
END $$;

-- 7-4. transfer_records.reviewed_by (VARCHAR → UUID)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='transfer_records' AND column_name='reviewed_by'
               AND data_type IN ('character varying','text')) THEN
    ALTER TABLE transfer_records DROP CONSTRAINT IF EXISTS transfer_records_reviewed_by_fkey;
    ALTER TABLE transfer_records ADD COLUMN IF NOT EXISTS reviewed_by_new UUID;
    UPDATE transfer_records t SET reviewed_by_new = m.new_id
      FROM _admin_user_id_map m WHERE m.old_id = t.reviewed_by::text;
    ALTER TABLE transfer_records DROP COLUMN reviewed_by;
    ALTER TABLE transfer_records RENAME COLUMN reviewed_by_new TO reviewed_by;
    ALTER TABLE transfer_records ADD CONSTRAINT transfer_records_reviewed_by_fkey
      FOREIGN KEY (reviewed_by) REFERENCES employees(id);
  END IF;
END $$;

-- 7-5. keyword_alerts.reviewed_by (VARCHAR → UUID)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='keyword_alerts' AND column_name='reviewed_by'
               AND data_type IN ('character varying','text')) THEN
    ALTER TABLE keyword_alerts DROP CONSTRAINT IF EXISTS keyword_alerts_reviewed_by_fkey;
    ALTER TABLE keyword_alerts ADD COLUMN IF NOT EXISTS reviewed_by_new UUID;
    UPDATE keyword_alerts k SET reviewed_by_new = m.new_id
      FROM _admin_user_id_map m WHERE m.old_id = k.reviewed_by::text;
    ALTER TABLE keyword_alerts DROP COLUMN reviewed_by;
    ALTER TABLE keyword_alerts RENAME COLUMN reviewed_by_new TO reviewed_by;
    ALTER TABLE keyword_alerts ADD CONSTRAINT keyword_alerts_reviewed_by_fkey
      FOREIGN KEY (reviewed_by) REFERENCES employees(id);
  END IF;
END $$;

-- 7-6. coaches.intro_reviewed_by 已搬到 employees.intro_reviewed_by (UUID)
--      將舊 admin_users.id (VARCHAR) 對應為新 UUID
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='coaches') THEN
    UPDATE employees e
    SET intro_reviewed_by = m.new_id
    FROM coaches c
    JOIN _admin_user_id_map m ON m.old_id = c.intro_reviewed_by
    WHERE e.id = c.id AND e.intro_reviewed_by IS NULL;
  END IF;
END $$;

-- 加上 employees.intro_reviewed_by → employees(id) FK
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employees_intro_reviewed_by_fkey') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_intro_reviewed_by_fkey
      FOREIGN KEY (intro_reviewed_by) REFERENCES employees(id);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 8. 重建 4 個 view（JOIN coaches → JOIN employees，coach_id → employee_id）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_course_period_summary AS
SELECT cp.id, cp.employee_id, e.name AS coach_name,
       e.is_senior, e.pricing_multiplier,
       cp.venue_id, v.name AS venue_name, cp.course_type,
       cp.total_sessions, cp.used_sessions,
       (cp.total_sessions - cp.used_sessions) AS remaining_sessions,
       cp.expires_at, cp.status, cp.final_price,
       cp.created_at
FROM course_periods cp
JOIN employees e ON cp.employee_id = e.id
JOIN venues v ON cp.venue_id = v.id;

CREATE OR REPLACE VIEW v_coach_weekly_schedule AS
SELECT cs.id AS session_id, cp.employee_id, e.name AS coach_name,
       cp.venue_id, v.name AS venue_name, cp.course_type,
       cs.scheduled_at, cs.duration_minutes, cs.status,
       ARRAY_AGG(s.name ORDER BY s.name) AS student_names,
       COUNT(s.id) AS student_count
FROM course_sessions cs
JOIN course_periods cp ON cs.course_period_id = cp.id
JOIN employees e ON cp.employee_id = e.id
JOIN venues v ON cp.venue_id = v.id
JOIN course_period_enrollments cpe ON cpe.course_period_id = cp.id AND cpe.status='active'
JOIN students s ON cpe.student_id = s.id
WHERE cs.status IN ('confirmed','completed')
GROUP BY cs.id, cp.employee_id, e.name, cp.venue_id, v.name, cp.course_type,
         cs.scheduled_at, cs.duration_minutes, cs.status;

CREATE OR REPLACE VIEW v_coach_evaluation_avg AS
SELECT cp.employee_id, e.name AS coach_name,
       e.is_senior, e.pricing_multiplier,
       COUNT(ce.id) AS total_evaluations,
       ROUND(AVG(ce.score_teaching)::numeric,2) AS avg_teaching_quality,
       ROUND(AVG(ce.score_attitude)::numeric,2) AS avg_communication,
       ROUND(AVG(ce.score_progress)::numeric,2) AS avg_student_progress,
       ROUND(AVG(ce.score_overall)::numeric,2)  AS avg_overall,
       COUNT(CASE WHEN ce.renew_intent='yes'         THEN 1 END) AS renew_yes,
       COUNT(CASE WHEN ce.renew_intent='no'          THEN 1 END) AS renew_no,
       COUNT(CASE WHEN ce.renew_intent='considering' THEN 1 END) AS renew_considering
FROM course_evaluations ce
JOIN course_periods cp ON ce.course_period_id = cp.id
JOIN employees e ON cp.employee_id = e.id
WHERE ce.submitted_at IS NOT NULL
GROUP BY cp.employee_id, e.name, e.is_senior, e.pricing_multiplier;

CREATE OR REPLACE VIEW v_coach_available_slots AS
SELECT cas.id, cas.employee_id, e.name AS coach_name,
       cas.venue_id, v.name AS venue_name,
       cas.start_at, cas.duration_minutes, cas.status, cas.notes,
       (cas.start_at + (cas.duration_minutes || ' minutes')::interval) AS end_at
FROM coach_availability_slots cas
JOIN employees e ON cas.employee_id = e.id
JOIN venues v ON cas.venue_id = v.id;

-- ----------------------------------------------------------------------------
-- 9. 舊表改名備份（admin_users / admin_staff 暫保留，未來再決定）
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='coaches') THEN
    ALTER TABLE coaches RENAME TO coaches_v7_backup;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 10. 清理臨時對應表（drop transaction-scoped temp table）
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS _admin_user_id_map;

COMMIT;

-- ============================================================================
-- 驗證查詢（手動跑）
-- ============================================================================
-- SELECT COUNT(*) FROM employees;
-- SELECT COUNT(*) FROM coaches_v7_backup;
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='course_periods' AND column_name='employee_id';
-- SELECT viewname FROM pg_views
--   WHERE viewname IN ('v_course_period_summary','v_coach_weekly_schedule',
--                      'v_coach_evaluation_avg','v_coach_available_slots');
-- ============================================================================
