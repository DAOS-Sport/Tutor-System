-- ============================================================
-- Migration 008: Employee Identity Consolidation
-- Task #51 — 合併 coaches / admin_users / admin_staff → employees (roles TEXT[])
--
-- 設計原則：
--   - 完全 idempotent：重複執行不報錯、不重複插入
--   - coaches.id (UUID) 直接沿用為 employees.id（FK 值不變）
--   - admin_users 以新 UUID 插入 employees（username 為 conflict key）
--   - roles 陣列：coach / manager / counter / system_admin
--   - 所有指向 coaches(id) 的 FK 改指向 employees(id)（UUID 相同，值有效）
--   - 所有指向 admin_users(id) 的 TEXT FK：drop FK → alter column to UUID →
--     set NULL（舊 U001 等 TEXT 值作廢）→ add FK → employees(id)
--   - coaches TABLE 改名為 coaches_v7_backup（資料保留，不再讀寫）
--   - 建立 VIEW coaches → employees WHERE 'coach' = ANY(roles)（讓舊查詢沿用）
--   - admin_users / admin_staff 暫時保留（不 drop / rename）
-- ============================================================

-- ─── 1. 建立 employees 表（若已存在則 skip）────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ragic_employee_id   VARCHAR(50),
  name                VARCHAR(200) NOT NULL DEFAULT '',
  phone               VARCHAR(20),
  email               VARCHAR(255),
  line_uid            VARCHAR(100),
  roles               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Coach-specific
  is_senior           BOOLEAN NOT NULL DEFAULT FALSE,
  pricing_multiplier  NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  specialties         TEXT[] DEFAULT ARRAY[]::TEXT[],
  bio_rich_text       TEXT NOT NULL DEFAULT '',
  intro_review_status VARCHAR(30) NOT NULL DEFAULT 'draft',
  intro_review_note   TEXT,
  intro_submitted_at  TIMESTAMPTZ,
  intro_reviewed_at   TIMESTAMPTZ,
  intro_reviewed_by   UUID,            -- FK to employees(id) added below
  -- Admin-specific
  username            VARCHAR(100),
  password_hash       TEXT,
  venue_id            VARCHAR(10),
  -- Shared
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  active_overridden_at TIMESTAMPTZ,
  ragic_record_id     VARCHAR(50),
  last_synced_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_ragic_id
  ON employees(ragic_employee_id) WHERE ragic_employee_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_username
  ON employees(username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_roles
  ON employees USING GIN(roles);
CREATE INDEX IF NOT EXISTS idx_employees_active
  ON employees(is_active);
CREATE INDEX IF NOT EXISTS idx_employees_phone
  ON employees(phone) WHERE phone IS NOT NULL;

-- Self-referencing FK for intro_reviewed_by
DO $$ BEGIN
  ALTER TABLE employees ADD CONSTRAINT fk_employees_intro_reviewed_by
    FOREIGN KEY (intro_reviewed_by) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── 2. 從 coaches 灌入 employees（同 UUID，roles=['coach']）──────
-- 只在 coaches 還是 TABLE 時執行（避免重複 migration 二次插入）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'coaches' AND relkind = 'r'  -- 'r' = ordinary table
  ) THEN
    INSERT INTO employees (
      id, ragic_employee_id, name, phone, email, line_uid,
      roles, is_senior, pricing_multiplier, specialties, bio_rich_text,
      intro_review_status, intro_review_note, intro_submitted_at,
      intro_reviewed_at,
      -- intro_reviewed_by 為 TEXT (admin_users.id)，無法轉 UUID → NULL
      is_active, active_overridden_at, ragic_record_id, last_synced_at,
      created_at, updated_at
    )
    SELECT
      c.id,
      c.ragic_employee_id,
      COALESCE(c.name, ''),
      c.phone,
      c.email,
      c.line_uid,
      ARRAY['coach']::TEXT[],
      COALESCE(c.is_senior, FALSE),
      COALESCE(c.pricing_multiplier, 1.00),
      COALESCE(c.specialties, ARRAY[]::TEXT[]),
      COALESCE(c.bio_rich_text, ''),
      COALESCE(c.intro_review_status, 'draft'),
      c.intro_review_note,
      c.intro_submitted_at,
      c.intro_reviewed_at,
      COALESCE(c.is_active, TRUE),
      c.active_overridden_at,
      c.ragic_record_id,
      c.last_synced_at,
      COALESCE(c.created_at, NOW()),
      COALESCE(c.updated_at, NOW())
    FROM coaches c
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- ─── 3. 從 admin_users 灌入 employees（新 UUID，依 username 去重）──
INSERT INTO employees (
  name, roles, username, password_hash, venue_id,
  is_active, active_overridden_at, created_at, updated_at
)
SELECT
  u.name,
  CASE u.role
    WHEN 'admin'   THEN ARRAY['system_admin']::TEXT[]
    WHEN 'manager' THEN ARRAY['manager']::TEXT[]
    WHEN 'staff'   THEN ARRAY['counter']::TEXT[]
    ELSE ARRAY['counter']::TEXT[]
  END,
  u.username,
  u.password_hash,
  u.venue_id,
  COALESCE(u.is_active, TRUE),
  u.active_overridden_at,
  COALESCE(u.created_at, NOW()),
  COALESCE(u.updated_at, NOW())
FROM admin_users u
WHERE NOT EXISTS (
  SELECT 1 FROM employees e WHERE e.username = u.username
);

-- ─── 4. 更新指向 coaches(id) 的 FK → employees(id)─────────────────
-- UUID 值相同（coaches 資料已完整複製到 employees），FK 重建安全。

-- coach_bio_media
DO $$ BEGIN
  ALTER TABLE coach_bio_media
    DROP CONSTRAINT IF EXISTS coach_bio_media_coach_id_fkey;
  ALTER TABLE coach_bio_media
    ADD CONSTRAINT fk_coach_bio_media_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

-- coach_venues
DO $$ BEGIN
  ALTER TABLE coach_venues DROP CONSTRAINT IF EXISTS coach_venues_coach_id_fkey;
  ALTER TABLE coach_venues ADD CONSTRAINT fk_coach_venues_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

-- coach_availability_slots
DO $$ BEGIN
  ALTER TABLE coach_availability_slots
    DROP CONSTRAINT IF EXISTS coach_availability_slots_coach_id_fkey;
  ALTER TABLE coach_availability_slots ADD CONSTRAINT fk_coach_slots_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

-- course_periods
DO $$ BEGIN
  ALTER TABLE course_periods DROP CONSTRAINT IF EXISTS course_periods_coach_id_fkey;
  ALTER TABLE course_periods ADD CONSTRAINT fk_course_periods_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- session_records
DO $$ BEGIN
  ALTER TABLE session_records
    DROP CONSTRAINT IF EXISTS session_records_coach_id_fkey;
  ALTER TABLE session_records ADD CONSTRAINT fk_session_records_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- session_record_versions (edited_by)
DO $$ BEGIN
  ALTER TABLE session_record_versions
    DROP CONSTRAINT IF EXISTS session_record_versions_edited_by_fkey;
  ALTER TABLE session_record_versions ADD CONSTRAINT fk_record_versions_employee
    FOREIGN KEY (edited_by) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- lesson_plans
DO $$ BEGIN
  ALTER TABLE lesson_plans DROP CONSTRAINT IF EXISTS lesson_plans_coach_id_fkey;
  ALTER TABLE lesson_plans ADD CONSTRAINT fk_lesson_plans_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

-- course_evaluations
DO $$ BEGIN
  ALTER TABLE course_evaluations
    DROP CONSTRAINT IF EXISTS course_evaluations_coach_id_fkey;
  ALTER TABLE course_evaluations ADD CONSTRAINT fk_course_evals_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- eval_threshold_alerts
DO $$ BEGIN
  ALTER TABLE eval_threshold_alerts
    DROP CONSTRAINT IF EXISTS eval_threshold_alerts_coach_id_fkey;
  ALTER TABLE eval_threshold_alerts ADD CONSTRAINT fk_eval_alerts_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

-- coach_personal_tags
DO $$ BEGIN
  ALTER TABLE coach_personal_tags
    DROP CONSTRAINT IF EXISTS coach_personal_tags_coach_id_fkey;
  ALTER TABLE coach_personal_tags ADD CONSTRAINT fk_personal_tags_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

-- referral_records
DO $$ BEGIN
  ALTER TABLE referral_records
    DROP CONSTRAINT IF EXISTS referral_records_coach_id_fkey;
  ALTER TABLE referral_records ADD CONSTRAINT fk_referrals_employee
    FOREIGN KEY (coach_id) REFERENCES employees(id) ON DELETE CASCADE;
EXCEPTION WHEN others THEN NULL; END $$;

-- ─── 5. 處理 admin_users TEXT FK 欄位 → UUID 改指向 employees ─────
-- 舊的 TEXT 值（'U001' 等）在 employees 中沒有對應 UUID → SET NULL

-- promotions.created_by  (TEXT → UUID)
DO $$ BEGIN
  ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_created_by_fkey;
  ALTER TABLE promotions ALTER COLUMN created_by TYPE UUID USING NULL::UUID;
  ALTER TABLE promotions ADD CONSTRAINT fk_promotions_created_by_employee
    FOREIGN KEY (created_by) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- promotions.reviewed_by (TEXT → UUID)
DO $$ BEGIN
  ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_reviewed_by_fkey;
  ALTER TABLE promotions ALTER COLUMN reviewed_by TYPE UUID USING NULL::UUID;
  ALTER TABLE promotions ADD CONSTRAINT fk_promotions_reviewed_by_employee
    FOREIGN KEY (reviewed_by) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- promotion_audit_logs.by_user (TEXT → UUID)
DO $$ BEGIN
  ALTER TABLE promotion_audit_logs
    DROP CONSTRAINT IF EXISTS promotion_audit_logs_by_user_fkey;
  ALTER TABLE promotion_audit_logs
    ALTER COLUMN by_user TYPE UUID USING NULL::UUID;
  ALTER TABLE promotion_audit_logs ADD CONSTRAINT fk_promo_audit_by_user_employee
    FOREIGN KEY (by_user) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- transfer_records.reviewed_by (TEXT → UUID)
DO $$ BEGIN
  ALTER TABLE transfer_records
    DROP CONSTRAINT IF EXISTS transfer_records_reviewed_by_fkey;
  ALTER TABLE transfer_records
    ALTER COLUMN reviewed_by TYPE UUID USING NULL::UUID;
  ALTER TABLE transfer_records ADD CONSTRAINT fk_transfers_reviewed_by_employee
    FOREIGN KEY (reviewed_by) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- keyword_alerts.reviewed_by (TEXT → UUID)
DO $$ BEGIN
  ALTER TABLE keyword_alerts DROP CONSTRAINT IF EXISTS keyword_alerts_reviewed_by_fkey;
  ALTER TABLE keyword_alerts ALTER COLUMN reviewed_by TYPE UUID USING NULL::UUID;
  ALTER TABLE keyword_alerts ADD CONSTRAINT fk_keyword_alerts_reviewed_by_employee
    FOREIGN KEY (reviewed_by) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN SQLSTATE '42703' THEN NULL; -- column does not exist
EXCEPTION WHEN others THEN NULL; END $$;

-- coaches.intro_reviewed_by （在舊 coaches TABLE 裡是 TEXT FK）
-- 已在步驟 2 複製時設為 NULL，此處只需確保 employees 的自參照 FK 已建立（步驟 1 已完成）

-- ragic_staging_changes.reviewed_by (TEXT → UUID) 若存在
DO $$ BEGIN
  ALTER TABLE ragic_staging_changes
    DROP CONSTRAINT IF EXISTS ragic_staging_changes_reviewed_by_fkey;
  -- reviewed_by 可能已是 UUID（各 task 分批建立），先嘗試轉型
  ALTER TABLE ragic_staging_changes
    ALTER COLUMN reviewed_by TYPE UUID USING NULL::UUID;
  ALTER TABLE ragic_staging_changes
    ADD CONSTRAINT fk_ragic_staging_reviewed_by_employee
    FOREIGN KEY (reviewed_by) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN SQLSTATE '42703' THEN NULL; -- column does not exist
EXCEPTION WHEN others THEN NULL; END $$;

-- ─── 6. 改名 coaches TABLE → coaches_v7_backup (只在仍是 TABLE 時執行)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'coaches' AND relkind = 'r'
  ) THEN
    ALTER TABLE coaches RENAME TO coaches_v7_backup;
  END IF;
END $$;

-- ─── 7. 建立 VIEW coaches（讓現有查詢不需改動）──────────────────────
-- 只包含 coach 相關欄位，不曝露 username / password_hash 等 admin 欄位
CREATE OR REPLACE VIEW coaches AS
  SELECT
    id, ragic_employee_id, name, phone, email, line_uid,
    is_senior, pricing_multiplier, specialties, bio_rich_text,
    intro_review_status, intro_review_note,
    intro_submitted_at, intro_reviewed_at, intro_reviewed_by,
    is_active, active_overridden_at, ragic_record_id, last_synced_at,
    created_at, updated_at
  FROM employees
  WHERE 'coach' = ANY(roles);
