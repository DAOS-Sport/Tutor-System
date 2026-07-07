/**
 * 核心 schema bootstrap：
 * - 將 db/migrations/001_initial_schema.sql 中、本 task #14 與後續 phase 真正會用到的表
 *   以 idempotent 方式建立（CREATE TYPE 用 DO $$ 包；CREATE TABLE 用 IF NOT EXISTS）
 * - seed 一份示範資料（4 教練 / 3 場館 / 3 家長 / 4 學員 / 3 期課程 / 8 個槽位 / 4 個今日已預約 sessions）
 *   讓 VITE_USE_MOCK=false build 時，教練端 LIFF 真的有資料可看
 *
 * 注意：本檔與 admin bootstrap 並行運作（admin_* 是獨立 namespace），seed 內容刻意對齊
 * `server/bootstrap/admin.js` 的 DEFAULT_VENUES / DEFAULT_STAFF 以利日後合併。
 */
const { pool } = require('../models/db');

const Z03_PURGE_SETTING_KEY = 'z03_hard_purge_20260703';

const DDL = `
-- ENUMs（重複建立會 throw duplicate_object）
DO $$ BEGIN CREATE TYPE course_period_status AS ENUM ('pending_payment','payment_anomaly','active','completed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE session_status AS ENUM ('pending_group_confirm','confirmed','completed','cancelled_normal','cancelled_penalty'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE slot_status AS ENUM ('available','pending_group_confirm','booked','blocked'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE enrollment_status AS ENUM ('active','transferred_out'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS venues (
  id VARCHAR(10) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  full_name VARCHAR(200),
  full_address TEXT,
  bank_institution_name VARCHAR(100),
  bank_branch_name VARCHAR(100),
  account_holder VARCHAR(100),
  account_number VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coaches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ragic_employee_id VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE,
  line_uid VARCHAR(100) UNIQUE,
  email VARCHAR(255),
  specialties TEXT[],
  is_senior BOOLEAN NOT NULL DEFAULT FALSE,
  pricing_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  bio_rich_text TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  intro_review_status VARCHAR(20) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coach_venues (
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  venue_id VARCHAR(10) NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  PRIMARY KEY (coach_id, venue_id)
);

CREATE TABLE IF NOT EXISTS coach_bio_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  media_type VARCHAR(10) NOT NULL DEFAULT 'image',
  storage_url TEXT NOT NULL,
  alt_text VARCHAR(200),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 教練端 LINE OAuth 模組（/api/coach-portal）：30天 portal session + OAuth 暫態 state
CREATE TABLE IF NOT EXISTS coach_portal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token VARCHAR(128) NOT NULL UNIQUE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  line_uid VARCHAR(100) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coach_portal_sessions_coach_id ON coach_portal_sessions(coach_id);
CREATE INDEX IF NOT EXISTS idx_coach_portal_sessions_expires_at ON coach_portal_sessions(expires_at);

-- OAuth CSRF state + callback 後一次性 handoff（DB-backed，多實例 / 重啟皆安全）
CREATE TABLE IF NOT EXISTS coach_oauth_states (
  token VARCHAR(128) PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,          -- 'csrf' | 'handoff'
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coach_oauth_states_expires_at ON coach_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS parents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_uid VARCHAR(100) UNIQUE,
  phone VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  primary_venue_id VARCHAR(10) REFERENCES venues(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- 軟刪除旗標：家長從 Ragic 主庫刪除時設為 FALSE，requireParent 即時拒絕（students FK 為 RESTRICT，無法硬刪）。
DO $$ BEGIN ALTER TABLE parents ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE; EXCEPTION WHEN undefined_table THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL,
  birth_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_type_configs (
  course_type  INTEGER PRIMARY KEY,
  label        VARCHAR(50) NOT NULL,
  max_students INTEGER NOT NULL,
  base_price   DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
DO $$ BEGIN ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS base_price DECIMAL(10,2) NOT NULL DEFAULT 0; EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- U5：團購人數下限（min_students <= max_students；預設 1，既有資料安全升級）
DO $$ BEGIN ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS min_students INTEGER NOT NULL DEFAULT 1; EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- F-A07 價格主資料源 + 資料日軌 + 排程生效：
--   base_price 為「每期價格（每人）」唯一來源（沿用既有欄位，不另建 price_per_period）。
--   updated_at：每次修改自動更新；data_group：資料管理群組；
--   effective_date：目前正式版本生效日；scheduled_effective_date + pending_changes(JSONB)：排程版本。
DO $$ BEGIN ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(); EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS data_group VARCHAR(100); EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS effective_date DATE; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS scheduled_effective_date DATE; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS pending_changes JSONB; EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- F-A07 排程「起訖日」：scheduled_effective_date=排程生效起日（既有）、scheduled_effective_until=排程生效迄日；
--   effective_date=目前生效起日(=使用期限起 starts_at，既有)、effective_until=目前生效版本迄日。
DO $$ BEGIN ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS scheduled_effective_until TIMESTAMPTZ; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE course_type_configs ADD COLUMN IF NOT EXISTS effective_until DATE; EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- F-A07 排程生效支援「日期＋時間」：scheduled_effective_date 由 DATE 升級為 TIMESTAMPTZ。
-- 僅在仍為 date 時轉換（既有日期值以台北時區午夜為準），避免每次開機重寫整表。
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'course_type_configs' AND column_name = 'scheduled_effective_date') = 'date' THEN
    ALTER TABLE course_type_configs
      ALTER COLUMN scheduled_effective_date TYPE TIMESTAMPTZ
      USING (scheduled_effective_date::timestamp AT TIME ZONE 'Asia/Taipei');
  END IF;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- F-A07「拿掉所有驗證」：放寬 label / data_group 長度上限（改 TEXT），讓後台可填任意長度，不再因欄位長度報錯。
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'course_type_configs' AND column_name = 'label') <> 'text' THEN
    ALTER TABLE course_type_configs ALTER COLUMN label TYPE TEXT;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'course_type_configs' AND column_name = 'data_group') NOT IN ('text') THEN
    ALTER TABLE course_type_configs ALTER COLUMN data_group TYPE TEXT;
  END IF;
EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_column THEN NULL; END $$;
-- 既有資料補預設：updated_at / effective_date 沿用 created_at；一對一(course_type=1)底價若為 0 補 9000（其餘品相不亂猜，維持現值）。
DO $$ BEGIN
  UPDATE course_type_configs SET updated_at = COALESCE(updated_at, created_at, NOW()) WHERE updated_at IS NULL;
  UPDATE course_type_configs SET effective_date = COALESCE(effective_date, created_at::date, CURRENT_DATE) WHERE effective_date IS NULL;
  UPDATE course_type_configs SET base_price = 9000 WHERE course_type = 1 AND (base_price IS NULL OR base_price = 0);
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- F-A07 編輯軌跡：每次 新增 / 編輯(立即) / 編輯(排程) / 取消排程 / 排程套用 各寫一筆（append-only）。
CREATE TABLE IF NOT EXISTS course_type_config_audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  course_type INTEGER NOT NULL REFERENCES course_type_configs(course_type) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action      TEXT NOT NULL,          -- 新增 / 編輯(立即) / 編輯(排程) / 取消排程 / 排程套用
  by_user     TEXT,                   -- 操作者（取自 req.adminUser；排程套用 = 'system'）
  changes     JSONB,                  -- { field: { before, after } }；僅記實際變動欄位，含排程起訖
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ctc_audit_type ON course_type_config_audit_logs(course_type, at DESC);

-- 學員資料編輯稽核：家長自己改 / 櫃檯改 / 管理員改，統一記錄誰改了什麼（before/after diff）。
-- 比照上面 course_type_config_audit_logs 同一套樣式；by_role 區分操作者身分
-- （'parent' | 'staff' | 'manager' | 'admin'），供 client/admin/src/pages/RagicZ02Modal.jsx
-- 顯示「編輯紀錄」清單用。
CREATE TABLE IF NOT EXISTS student_audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action     TEXT NOT NULL,        -- 'create' | 'edit'
  by_user    TEXT,                 -- 顯示用姓名/帳號
  by_role    TEXT,                 -- 'parent' | 'staff' | 'manager' | 'admin'
  changes    JSONB,                -- { field: { before, after } }；只記實際變動欄位
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_student_audit_student ON student_audit_logs(student_id, at DESC);

-- ─────────────────────────────────────────────────────────────
-- U5：團購（group buy）資料模型
--   group_orders        — 一張團購單（團主發起、含人數上下限快照、join_token）
--   group_order_members — 加入該團的家長 + 各自學生名單 + 匯款證明
-- status 流程：forming（揪團中）→ submitted（團主送審）→ approved / rejected；可 cancelled。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  venue_id         VARCHAR(10) NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  course_type      INTEGER NOT NULL REFERENCES course_type_configs(course_type) ON DELETE RESTRICT,
  coach_id         UUID REFERENCES coaches(id) ON DELETE SET NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'forming',
  join_token       VARCHAR(64) NOT NULL UNIQUE,
  min_students     INTEGER NOT NULL DEFAULT 1,
  max_students     INTEGER NOT NULL DEFAULT 1,
  note             TEXT,
  submitted_at     TIMESTAMPTZ,
  reviewed_by      VARCHAR(50),
  reviewed_at      TIMESTAMPTZ,
  reject_reason    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_group_orders_token  ON group_orders(join_token);
CREATE INDEX IF NOT EXISTS idx_group_orders_status ON group_orders(status);
CREATE INDEX IF NOT EXISTS idx_group_orders_leader ON group_orders(leader_parent_id);

CREATE TABLE IF NOT EXISTS group_order_members (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_order_id    UUID NOT NULL REFERENCES group_orders(id) ON DELETE CASCADE,
  parent_id         UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  student_names     TEXT[] NOT NULL DEFAULT '{}',
  -- U7：加入時綁定的正式學員 id（student_names 仍保留供顯示／向後相容）
  student_ids       UUID[] NOT NULL DEFAULT '{}',
  transfer_last_5   VARCHAR(5),
  payment_proof_url TEXT,
  is_leader         BOOLEAN NOT NULL DEFAULT FALSE,
  status            VARCHAR(20) NOT NULL DEFAULT 'joined',
  joined_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_order_id, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_order  ON group_order_members(group_order_id);
CREATE INDEX IF NOT EXISTS idx_group_members_parent ON group_order_members(parent_id);

-- ─────────────────────────────────────────────────────────────
-- 團報「草稿暫存」：客人端發起團購頁填到一半時，先把未完成資訊存起來，
--   重整 / 切走 / 換裝置回來都不流失（每位家長保留一筆「進行中」草稿）。
--   正式建立團購成功後即刪除此草稿。payload 整包存 JSONB（venue/coach/
--   courseType/已選學員/新增學員/匯款證明/備註），結構鬆綁、容前端演進。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_order_drafts (
  parent_id   UUID PRIMARY KEY REFERENCES parents(id) ON DELETE CASCADE,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  venue_id VARCHAR(10) NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  course_type INTEGER NOT NULL CHECK (course_type >= 1),
  total_sessions INTEGER NOT NULL DEFAULT 6,
  used_sessions INTEGER NOT NULL DEFAULT 0,
  expires_at DATE NOT NULL,
  original_price DECIMAL(10,2) NOT NULL,
  final_price DECIMAL(10,2) NOT NULL,
  status course_period_status NOT NULL DEFAULT 'pending_payment',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_period_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  status enrollment_status NOT NULL DEFAULT 'active',
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(course_period_id, student_id)
);

CREATE TABLE IF NOT EXISTS coach_availability_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  venue_id VARCHAR(10) NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  start_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  status slot_status NOT NULL DEFAULT 'available',
  booked_session_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(coach_id, start_at)
);
CREATE INDEX IF NOT EXISTS idx_slots_coach ON coach_availability_slots(coach_id);
CREATE INDEX IF NOT EXISTS idx_slots_start ON coach_availability_slots(start_at);

CREATE TABLE IF NOT EXISTS course_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE CASCADE,
  availability_slot_id UUID REFERENCES coach_availability_slots(id),
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  status session_status NOT NULL DEFAULT 'confirmed',
  initiated_by_parent_id UUID REFERENCES parents(id),
  group_confirm_status JSONB,
  group_confirm_deadline TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_period ON course_sessions(course_period_id);
CREATE INDEX IF NOT EXISTS idx_sessions_scheduled ON course_sessions(scheduled_at);

DO $$ BEGIN
  ALTER TABLE coach_availability_slots
    ADD CONSTRAINT fk_slot_session FOREIGN KEY (booked_session_id) REFERENCES course_sessions(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 已存在 schema 的安全升級（向前相容已套用 001_initial_schema.sql 的環境）
DO $$ BEGIN ALTER TABLE coaches ADD COLUMN IF NOT EXISTS bio_rich_text TEXT; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE coaches ADD COLUMN IF NOT EXISTS intro_review_status VARCHAR(20) NOT NULL DEFAULT 'draft'; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE coaches ADD COLUMN IF NOT EXISTS pricing_multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.00; EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- Task #53：is_active 手動覆寫旗標 — 後台勾啟用後 Ragic 同步不再覆蓋
DO $$ BEGIN ALTER TABLE coaches ADD COLUMN IF NOT EXISTS active_overridden_at TIMESTAMPTZ; EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- Task #53：載入效能 — coaches 列表常依 is_active + name 過濾
CREATE INDEX IF NOT EXISTS idx_coaches_active ON coaches(is_active);
DO $$ BEGIN ALTER TABLE coach_availability_slots ADD COLUMN IF NOT EXISTS notes TEXT; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE coach_availability_slots ADD COLUMN IF NOT EXISTS booked_session_id UUID; EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- Task #67：admin_course_intros 增 title_overridden 旗標（true 表示 admin 改過 title，label 同步時不再覆蓋）
DO $$ BEGIN
  ALTER TABLE admin_course_intros ADD COLUMN IF NOT EXISTS title_overridden BOOLEAN NOT NULL DEFAULT FALSE;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS checkin_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_session_id UUID NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  is_auto_linked BOOLEAN NOT NULL DEFAULT FALSE,
  checked_in_source VARCHAR(20) NOT NULL DEFAULT 'parent',
  checked_in_by_parent_id UUID REFERENCES parents(id),
  checked_in_by_coach_id UUID REFERENCES coaches(id),
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_session_id, student_id)
);
DO $$ BEGIN ALTER TABLE checkin_records ADD COLUMN IF NOT EXISTS checked_in_source VARCHAR(20) NOT NULL DEFAULT 'parent'; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE checkin_records ADD COLUMN IF NOT EXISTS checked_in_by_parent_id UUID REFERENCES parents(id); EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE checkin_records ADD COLUMN IF NOT EXISTS checked_in_by_coach_id UUID REFERENCES coaches(id); EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'checkin_records'
       AND column_name = 'checked_in_by_student_id'
  ) THEN
    ALTER TABLE checkin_records ALTER COLUMN checked_in_by_student_id DROP NOT NULL;
  END IF;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ─── Phase 4: 聊天室 / 訊息 / 關鍵字警示 ───────────────────────────────
DO $$ BEGIN CREATE TYPE alert_status AS ENUM ('pending','reviewed','no_issue','resolved'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS chat_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(course_period_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_room_id UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  sender_type VARCHAR(10) NOT NULL,           -- 'parent' | 'coach' | 'system'
  sender_id UUID,                             -- nullable for 'system'
  message_type VARCHAR(10) NOT NULL DEFAULT 'text', -- text|image|voice|video|file
  content TEXT,
  media_url TEXT,
  media_filename VARCHAR(255),
  media_size_bytes BIGINT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(chat_room_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

CREATE TABLE IF NOT EXISTS message_reads (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reader_type VARCHAR(10) NOT NULL,           -- 'parent' | 'coach'
  reader_id UUID NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, reader_type, reader_id)
);

CREATE TABLE IF NOT EXISTS keyword_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword VARCHAR(100) NOT NULL UNIQUE,
  category VARCHAR(30) NOT NULL,              -- 違規收費 / 不當言論 / 私下交易 / 其他
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS keyword_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_room_id UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  triggered_keyword VARCHAR(100) NOT NULL,
  status alert_status NOT NULL DEFAULT 'pending',
  reviewed_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON keyword_alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_room ON keyword_alerts(chat_room_id);

-- ─── Phase 5: 學習歷程 + 期末評鑑 + 標籤庫 + 教練介紹送審 ────────────────
-- 標籤庫（F-A08）：分類 + 系統預設 + 教練個人標籤
CREATE TABLE IF NOT EXISTS tag_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(40) NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tag_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES tag_categories(id) ON DELETE CASCADE,
  label VARCHAR(40) NOT NULL,
  text_template TEXT NOT NULL,             -- 點擊後自動帶入授課記錄文案
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(category_id, label)
);

CREATE TABLE IF NOT EXISTS coach_personal_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  category_id UUID REFERENCES tag_categories(id) ON DELETE SET NULL,
  label VARCHAR(40) NOT NULL,
  text_template TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(coach_id, label)
);
DO $$ BEGIN
  ALTER TABLE coach_personal_tags ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES tag_categories(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ── 升級舊版（001_initial_schema.sql 已建立、欄位不同）── 與 005 migration 一致
DO $$ BEGIN
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS course_period_id UUID REFERENCES course_periods(id) ON DELETE CASCADE;
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaches(id) ON DELETE RESTRICT;
  -- Task #59：admin_enrollments 加 coach_id 軟 FK；course_periods 加 admin_enrollment_id 反向軟連結；
  -- course_sessions 加 coach_id 以支援「換教練只動未來課」的 per-session 指派。
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaches(id) ON DELETE SET NULL;
  ALTER TABLE course_periods    ADD COLUMN IF NOT EXISTS admin_enrollment_id TEXT;
  -- 團報：一團共用一個 course_period。對帳建課時以 group_order_id 做冪等 get-or-create
  -- （同團多位成員逐筆對帳時不會重複建 period）。一般報名此欄為 NULL。
  ALTER TABLE course_periods    ADD COLUMN IF NOT EXISTS group_order_id UUID;
  -- 訂單依期數拆分：course_periods 也記 period_number；團報一團 N 期 → 每期各自一個 period。
  ALTER TABLE course_periods    ADD COLUMN IF NOT EXISTS period_number INTEGER NOT NULL DEFAULT 1;
  -- 唯一鍵由單欄 (group_order_id) 改複合 (group_order_id, period_number)：
  -- 既有同名單欄索引，CREATE IF NOT EXISTS 會直接略過、無法自動升級，故先 DROP 再重建。
  -- 容錯（失敗只警告不中斷啟動，沿用本檔既有 pattern）：歷史資料一團一期、period_number 預設 1，不會撞重複。
  BEGIN
    DROP INDEX IF EXISTS uq_course_periods_group_order;
    CREATE UNIQUE INDEX uq_course_periods_group_order
      ON course_periods(group_order_id, period_number) WHERE group_order_id IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'uq_course_periods_group_order 複合索引重建失敗（可能有重複資料），略過: %', SQLERRM;
  END;
  -- U11 一般報名橋：一般報名以 admin_enrollment_id 冪等 get-or-create 一個 course_period。
  -- 容錯建立：若正式環境已有重複 admin_enrollment_id 的歷史資料，索引建不起來也不中斷啟動
  --（橋本身用 check-then-insert，不硬依賴此索引；索引只是額外的唯一性兜底）。
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_course_periods_admin_enrollment
      ON course_periods(admin_enrollment_id) WHERE admin_enrollment_id IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'uq_course_periods_admin_enrollment 建立失敗（可能有重複 admin_enrollment_id），略過: %', SQLERRM;
  END;
  ALTER TABLE course_sessions   ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaches(id) ON DELETE RESTRICT;
  -- F2：換教練歸屬。reassigned_from_coach_id 記錄「轉走前的原授課教練」，
  -- 讓新教練端可顯示「原授課教練 X」。COALESCE 保留首次原教練（多次轉派仍指向最初）。
  ALTER TABLE course_sessions   ADD COLUMN IF NOT EXISTS reassigned_from_coach_id UUID REFERENCES coaches(id) ON DELETE SET NULL;
  -- F2 backfill：早期 session 建立時未寫 coach_id（NULL），以所屬 period 的教練補齊，
  -- 讓「改讀 per-session coach_id」的查詢對既有資料一致生效（idempotent，只補 NULL）。
  UPDATE course_sessions cs SET coach_id = cp.coach_id
    FROM course_periods cp
   WHERE cs.course_period_id = cp.id AND cs.coach_id IS NULL AND cp.coach_id IS NOT NULL;
  -- U3：家長端報名「匯款／轉帳證明」上傳網址（必填，pending_payment 對帳時供櫃檯檢視）。
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS payment_proof_url TEXT;
  -- U6：團購核准後產生的報名，回連 group_orders.id 並標記為共享班（前端可顯示「團購」徽章）。
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS group_order_id UUID;
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS is_group_shared BOOLEAN NOT NULL DEFAULT FALSE;
  -- U7：團購成員綁定的正式學員 id（既有資料安全升級，預設空陣列）。
  ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS student_ids UUID[] NOT NULL DEFAULT '{}';
  -- U9：團報「複數期數」——一張團報訂單可一次購買多期（名單鎖定不變）。
  --   total_sessions = sessions_per_period × period_count；既有資料預設 1 期，安全升級。
  ALTER TABLE group_orders      ADD COLUMN IF NOT EXISTS period_count INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS period_count INTEGER NOT NULL DEFAULT 1;
  -- 訂單依期數拆分：每期一筆 admin_enrollments（period_count=1），period_number 標示第幾期；
  -- 同次購買的 N 筆共用 enrollment_batch_id 供前端/後台成組顯示。既有資料預設 1/NULL，前向相容。
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS period_number INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS enrollment_batch_id UUID;
  -- 載具（電子發票手機條碼載具）：報名繳款時填寫，櫃檯開發票時產生橫列式條碼掃描用。
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS carrier TEXT;
  -- 退費時間：退課退費送出當下時間戳（退費列表顯示用；舊資料為 NULL）。
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
  -- 011 櫃檯手動建檔：Ragic 報名表外觀欄位（手動建檔表單寫入）+ Ragic 回寫/webhook 橋接欄。
  --   橋接欄 (ragic_record_id/external_order_no/last_pushed_at/ragic_content_hash) 於 Phase 3/4
  --   接 Ragic 回寫與雙向同步時才填；Phase 0 僅 sync_source 預設 'replit'（webhook 防迴圈用）。
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS payer            TEXT;          -- 收款人
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS class_name       TEXT;          -- 班級名稱
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS payment_method   TEXT;          -- 付款方式：現金 / 轉帳
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS allowance_amount NUMERIC(10,2); -- 折讓金額
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS tax_id           VARCHAR(20);   -- 統一編號
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS level_note       TEXT;          -- 程度說明
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS unit_price       NUMERIC(10,2); -- 實際單價
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS work_type        TEXT;          -- 作業型態
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS full_sessions    INTEGER;       -- 完整堂數
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS ragic_record_id    VARCHAR(50);
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS external_order_no  TEXT;        -- Ragic 報名單號，idempotency key
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS sync_source        TEXT NOT NULL DEFAULT 'replit';
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS last_pushed_at     TIMESTAMPTZ;
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS ragic_content_hash TEXT;
  -- C-6：手動建檔的資料建立人（FK admin_users.id；比照 promotions.created_by 同一套樣式）。
  -- 一律由後端從登入 token 決定（見 routes/admin/enrollments.js createdBy），不接受前端傳值。
  ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_enrollments_external_order_no
    ON admin_enrollments(external_order_no) WHERE external_order_no IS NOT NULL;
  -- 櫃台補簽到（F-R01）：checkin_at = 選擇的上課/簽到時間；backfilled_at = 補簽到按鈕被按下的時間（供管理端查看）。
  ALTER TABLE admin_today_sessions ADD COLUMN IF NOT EXISTS checkin_at TIMESTAMPTZ;
  ALTER TABLE admin_today_sessions ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMPTZ;
  -- U10：團報金流改流程——證明改「送審後各家自行上傳」，櫃檯「逐家確認帳款」+「核准名單」，
  --   兩者皆成立才自動建檔。成員層級記證明上傳時間 + 帳款確認狀態；訂單層級記名單核准狀態。
  ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS proof_uploaded_at   TIMESTAMPTZ;
  ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS transfer_last_5     VARCHAR(5);
  ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS payment_confirmed   BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
  ALTER TABLE group_order_members ADD COLUMN IF NOT EXISTS payment_confirmed_by VARCHAR(50);
  ALTER TABLE group_orders        ADD COLUMN IF NOT EXISTS roster_approved     BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE group_orders        ADD COLUMN IF NOT EXISTS roster_approved_at  TIMESTAMPTZ;
  ALTER TABLE group_orders        ADD COLUMN IF NOT EXISTS roster_approved_by  VARCHAR(50);
  -- Task #59：transfer_coach 結構化欄位（before/after，名稱保留作可讀紀錄；UUID 為查詢索引）
  ALTER TABLE admin_enrollment_audit_logs ADD COLUMN IF NOT EXISTS before_coach_id UUID;
  ALTER TABLE admin_enrollment_audit_logs ADD COLUMN IF NOT EXISTS after_coach_id  UUID;
  ALTER TABLE admin_enrollment_audit_logs ADD COLUMN IF NOT EXISTS before_coach    TEXT;
  ALTER TABLE admin_enrollment_audit_logs ADD COLUMN IF NOT EXISTS after_coach     TEXT;
  ALTER TABLE admin_enrollment_audit_logs ADD COLUMN IF NOT EXISTS before_venue_id VARCHAR(10);
  ALTER TABLE admin_enrollment_audit_logs ADD COLUMN IF NOT EXISTS after_venue_id  VARCHAR(10);
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS highlights TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS improvements TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS homework TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS student_records JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
  BEGIN
    ALTER TABLE session_records ALTER COLUMN status TYPE VARCHAR(10) USING status::text;
    ALTER TABLE session_records ALTER COLUMN status SET DEFAULT 'draft';
  EXCEPTION WHEN others THEN NULL; END;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE session_record_versions ADD COLUMN IF NOT EXISTS version_no INTEGER;
  ALTER TABLE session_record_versions ADD COLUMN IF NOT EXISTS snapshot JSONB;
  ALTER TABLE session_record_versions ADD COLUMN IF NOT EXISTS edited_by UUID REFERENCES coaches(id) ON DELETE RESTRICT;
  BEGIN ALTER TABLE session_record_versions ALTER COLUMN version_number DROP NOT NULL; EXCEPTION WHEN undefined_column THEN NULL; END;
  BEGIN ALTER TABLE session_record_versions ALTER COLUMN content_snapshot DROP NOT NULL; EXCEPTION WHEN undefined_column THEN NULL; END;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'session_record_tags' AND column_name = 'tag_text') THEN
    DROP TABLE session_record_tags CASCADE;
  END IF;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaches(id) ON DELETE RESTRICT;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS score_teaching INTEGER;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS score_attitude INTEGER;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS score_progress INTEGER;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS score_overall INTEGER;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS comment TEXT NOT NULL DEFAULT '';
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS renew_intent VARCHAR(10) NOT NULL DEFAULT 'unknown';
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  BEGIN
    UPDATE course_evaluations SET
      score_teaching = COALESCE(score_teaching, teaching_quality),
      score_attitude = COALESCE(score_attitude, communication_attitude),
      score_progress = COALESCE(score_progress, student_progress),
      score_overall  = COALESCE(score_overall,  overall_satisfaction),
      comment        = COALESCE(NULLIF(comment, ''), COALESCE(text_feedback, '')),
      renew_intent   = CASE WHEN renew_intent <> 'unknown' THEN renew_intent
                            WHEN renew_intention::text IN ('yes','no') THEN renew_intention::text
                            ELSE 'unknown' END;
  EXCEPTION WHEN undefined_column THEN NULL; END;
  UPDATE course_evaluations ce SET coach_id = cp.coach_id
    FROM course_periods cp WHERE ce.coach_id IS NULL AND ce.course_period_id = cp.id;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- 課前規劃（F-C04）：每個 course_period 一份，draft → published
CREATE TABLE IF NOT EXISTS lesson_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  goals TEXT NOT NULL DEFAULT '',
  expected_outcomes TEXT NOT NULL DEFAULT '',
  learning_plan TEXT NOT NULL DEFAULT '',
  initial_assessment TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'draft',  -- draft | published
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_period_id)
);

-- 授課記錄（F-C05）：每堂課一筆，draft → submitted；submitted 之後改寫入 versions
CREATE TABLE IF NOT EXISTS session_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_session_id UUID NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  summary TEXT NOT NULL DEFAULT '',         -- 上課摘要
  highlights TEXT NOT NULL DEFAULT '',      -- 表現亮點
  improvements TEXT NOT NULL DEFAULT '',    -- 待加強
  homework TEXT NOT NULL DEFAULT '',        -- 回家練習
  notes TEXT NOT NULL DEFAULT '',           -- 備註（給家長的提醒）
  status VARCHAR(10) NOT NULL DEFAULT 'draft', -- draft | submitted
  media JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ url, mime, name, size }]
  student_records JSONB NOT NULL DEFAULT '{}'::jsonb, -- { mode, records: { studentName: fields } }
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_session_id)
);
CREATE INDEX IF NOT EXISTS idx_records_period ON session_records(course_period_id);

CREATE TABLE IF NOT EXISTS session_record_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_record_id UUID NOT NULL REFERENCES session_records(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  snapshot JSONB NOT NULL,                  -- 完整欄位快照
  edited_by UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_record_id, version_no)
);

CREATE TABLE IF NOT EXISTS session_record_tags (
  session_record_id UUID NOT NULL REFERENCES session_records(id) ON DELETE CASCADE,
  tag_library_id UUID REFERENCES tag_library(id) ON DELETE SET NULL,
  personal_tag_id UUID REFERENCES coach_personal_tags(id) ON DELETE SET NULL,
  label VARCHAR(40) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_record_id, label)
);

-- 期末評鑑（F-S12 / F-M09）：每個 course_period 一筆 invitation → submission
CREATE TABLE IF NOT EXISTS course_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE CASCADE,
  parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reminder_sent_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  -- 4 維度星星（1-5）；NULL 表示尚未填寫
  score_teaching INTEGER,
  score_attitude INTEGER,
  score_progress INTEGER,
  score_overall INTEGER,
  comment TEXT NOT NULL DEFAULT '',
  renew_intent VARCHAR(10) NOT NULL DEFAULT 'unknown', -- yes | no | unknown
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_period_id, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_eval_coach ON course_evaluations(coach_id);
CREATE INDEX IF NOT EXISTS idx_eval_submitted ON course_evaluations(submitted_at);

-- 考核門檻（F-A09）：admin 設定後系統據此判斷教練是否達標
CREATE TABLE IF NOT EXISTS eval_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric VARCHAR(40) NOT NULL UNIQUE,    -- avg_overall / avg_teaching / renew_rate
  min_value NUMERIC(5,2) NOT NULL,
  window_months INTEGER NOT NULL DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 不達標警示（dedupe by coach+metric+月份；主管通知記錄）
CREATE TABLE IF NOT EXISTS eval_threshold_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  metric VARCHAR(40) NOT NULL,
  observed_value NUMERIC(5,2),
  min_value NUMERIC(5,2) NOT NULL,
  window_months INTEGER NOT NULL,
  period_month CHAR(7) NOT NULL,         -- 'YYYY-MM'：同月不重複通知
  notified_at TIMESTAMPTZ,               -- 已推給主管的時間（NULL = 尚未推）
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(coach_id, metric, period_month)
);
CREATE INDEX IF NOT EXISTS idx_eval_alerts_pending ON eval_threshold_alerts(notified_at) WHERE notified_at IS NULL;

-- Task #65：Ragic 同步紀錄。每次 syncStaff/syncCoaches/syncVenues 結束（成功 / 失敗 / 跳過）寫一筆。
-- 後台「Ragic 連線狀態」頁面用最新一筆 + 最新一筆 status='ok' 算狀態。
-- (Task #65) ragic_sync_log
CREATE TABLE IF NOT EXISTS ragic_sync_log (
  id BIGSERIAL PRIMARY KEY,
  form_code VARCHAR(40) NOT NULL,        -- H01_STAFF | H01_COACHES | H05_VENUES
  job_name  VARCHAR(40) NOT NULL,        -- staff | coaches | venues
  status    VARCHAR(20) NOT NULL,        -- ok | error | skipped | partial | stale_read
  synced_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  freshness_verified BOOLEAN,
  freshness_latency_ms INTEGER,
  stale_retries INTEGER NOT NULL DEFAULT 0,
  freshness_nonce TEXT,
  triggered_by VARCHAR(20) NOT NULL DEFAULT 'cron', -- cron | manual | startup
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN ALTER TABLE ragic_sync_log ALTER COLUMN status TYPE VARCHAR(20); EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ragic_sync_log ADD COLUMN IF NOT EXISTS freshness_verified BOOLEAN; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ragic_sync_log ADD COLUMN IF NOT EXISTS freshness_latency_ms INTEGER; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ragic_sync_log ADD COLUMN IF NOT EXISTS stale_retries INTEGER NOT NULL DEFAULT 0; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ragic_sync_log ADD COLUMN IF NOT EXISTS freshness_nonce TEXT; EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_ragic_sync_log_form ON ragic_sync_log(form_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ragic_sync_log_job  ON ragic_sync_log(job_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ragic_sync_log_freshness ON ragic_sync_log(form_code, created_at DESC)
  WHERE freshness_verified IS NOT NULL OR status = 'stale_read';

-- Ragic writer audit: append-only log for attempted field writes and rejection reasons.
CREATE TABLE IF NOT EXISTS ragic_write_audit (
  id BIGSERIAL PRIMARY KEY,
  sheet_code VARCHAR(20) NOT NULL,
  record_key TEXT,
  field_id TEXT,
  old_value TEXT,
  new_value TEXT,
  actor TEXT,
  source TEXT,
  status VARCHAR(20) NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ragic_write_audit_sheet_time
  ON ragic_write_audit(sheet_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ragic_write_audit_rejected
  ON ragic_write_audit(created_at DESC)
  WHERE status = 'rejected';

-- Z01 家長姓名資料品質追蹤：舊系統匯入批次曾把「家長姓名」欄位誤填成電話號碼
-- （已證實：2026-06-30 匯入的 511 筆裡 433 筆），需要一張表追蹤哪些 Z01 記錄還沒
-- 修正，避免同一筆爛資料每晚被重複處理，並在治癒（家長自己把姓名改對）後知道要
-- 回頭清哪一筆。z03_ragic_record_id / resolved_at 相關的「推送到 Z03、清理 Z03」
-- 邏輯目前卡在 Z03 表單尚未確認存在與欄位定義，暫緩實作；本表本身不依賴 Z03 就能先建。
CREATE TABLE IF NOT EXISTS ragic_z01_quarantine (
  id BIGSERIAL PRIMARY KEY,
  z01_ragic_record_id VARCHAR(50) NOT NULL UNIQUE,
  phone VARCHAR(20) NOT NULL,
  bad_name TEXT NOT NULL,
  z03_ragic_record_id VARCHAR(50),
  pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_ragic_z01_quarantine_unresolved ON ragic_z01_quarantine(phone) WHERE resolved_at IS NULL;

-- Z03：本地完整鏡射「壞姓名」Z01 家長 + 底下學員子表格（與上面 ragic_z01_quarantine
-- 並存，互不取代）。壞名字且尚未有真人登入過（本地 parents.line_uid 為空）的記錄
-- 只落到這裡，不進 parents/students；姓名在 Ragic 端被改好後，下一輪 01:00 pull
-- 會自動把這筆標記 resolved 並正常同步進 parents（見 ragicAdmin.js _pullParentsStudentsImpl）。
-- 欄位一律存 Ragic 原始值（不經 mapZ01Parent/normalizeGender 等正規化），
-- 讓人工看到 Ragic 裡實際長什麼樣去修正，欄位名一律加 _raw 後綴標示。
CREATE TABLE IF NOT EXISTS ragic_z03_records (
  id BIGSERIAL PRIMARY KEY,
  z01_ragic_record_id VARCHAR(50) NOT NULL UNIQUE,
  raw_name TEXT, venue_raw TEXT, phone TEXT, identity_raw TEXT, gender_raw TEXT,
  email_raw TEXT, home_phone_raw TEXT, home_address_raw TEXT, line_id_raw TEXT,
  line_chat_url_raw TEXT, line_uid_raw TEXT, student_count_raw TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | resolved | dismissed
  fixed_name TEXT, resolved_at TIMESTAMPTZ, resolved_by TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ragic_z03_records_pending ON ragic_z03_records(status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ragic_z03_students (
  id BIGSERIAL PRIMARY KEY,
  z03_record_id BIGINT NOT NULL REFERENCES ragic_z03_records(id) ON DELETE CASCADE,
  seq_raw TEXT, student_status_raw TEXT, name_raw TEXT, birth_date_raw TEXT,
  gender_raw TEXT, id_number_raw TEXT, blood_type_raw TEXT, age_raw TEXT,
  student_code_raw TEXT, registered_phone_raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_ragic_z03_students_record ON ragic_z03_students(z03_record_id);

-- Z03 強制刪除 tombstone：ragic_z03_records 是靠 z01_ragic_record_id 當唯一鍵、由每次
-- Z01→Z03 拉回同步（ON CONFLICT ... DO UPDATE）持續維護的衍生佇列，單純 DELETE 該筆
-- 下次同步就會復活。管理員在後台「強制刪除」一筆 Z03 記錄時，連同寫入本表一筆
-- tombstone；之後每次 upsert 前先查本表，命中就整筆跳過、不再寫入/更新 ragic_z03_records
-- （來源 Ragic Z01 原始記錄本身完全不動，Ragic 是權威來源，本 app 不寫回）。
CREATE TABLE IF NOT EXISTS ragic_z03_deleted_tombstones (
  z01_ragic_record_id TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by TEXT,
  reason TEXT
);

-- Task #66：Ragic 待審核區（同步先進 staging，admin 通過才合併到正式表）
CREATE TABLE IF NOT EXISTS ragic_staging_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_code   VARCHAR(40) NOT NULL,                 -- H01_STAFF | H01_COACHES | H05_VENUES
  entity_type VARCHAR(20) NOT NULL,                 -- staff | coach | venue
  entity_id   VARCHAR(50) NOT NULL,                 -- ragic_employee_id / venue code
  change_type VARCHAR(20) NOT NULL,                 -- new | update | deactivate
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 同步當下從 Ragic 抓到的完整可寫欄位
  diff_json    JSONB,                               -- update：{field: {from, to}}；new/deactivate 可為 null
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | approved | rejected | auto_resolved
  reviewed_by  TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  reject_reason TEXT
);
-- 每個 UID（entity_type, entity_id）只保留「一筆」staging，就地更新（以 UID 為該用戶資料的真相）。
-- 舊設計用「WHERE status='pending'」的局部唯一索引 → 只 dedup pending；一旦轉成
-- approved/auto_resolved/rejected，下次 sync 有差異就「再 INSERT 一筆」→ 同一人累積多筆歷史。
-- 改為全狀態唯一：先收斂既有重複列（保留 pending 優先、否則最新 fetched_at），再建全唯一索引。
DELETE FROM ragic_staging_changes a
 USING (
   SELECT id, ROW_NUMBER() OVER (
            PARTITION BY entity_type, entity_id
            ORDER BY (status = 'pending') DESC, fetched_at DESC
          ) AS rn
     FROM ragic_staging_changes
 ) d
 WHERE a.id = d.id AND d.rn > 1;
DROP INDEX IF EXISTS uq_ragic_staging_pending;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ragic_staging_entity
  ON ragic_staging_changes(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_ragic_staging_status ON ragic_staging_changes(status, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_ragic_staging_form ON ragic_staging_changes(form_code, status);

-- 教練介紹送審（F-C06）：教練端編輯 → 主管審核
DO $$ BEGIN
  ALTER TABLE coaches ADD COLUMN IF NOT EXISTS intro_review_note TEXT;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- 一次性升級舊資料：legacy 'submitted' → 'pending_review'（與 admin 端一致）
DO $$ BEGIN
  UPDATE coaches SET intro_review_status = 'pending_review' WHERE intro_review_status = 'submitted';
EXCEPTION WHEN undefined_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE coaches ADD COLUMN IF NOT EXISTS intro_submitted_at TIMESTAMPTZ;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE coaches ADD COLUMN IF NOT EXISTS intro_reviewed_at TIMESTAMPTZ;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE coaches ADD COLUMN IF NOT EXISTS intro_reviewed_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ── Phase 6 (上)：優惠活動 + 折價券 + 套用紀錄 ────────────────────────
-- F-M07 主管建立 → F-A05 管理員核准 → 進入 active；LIFF 購課讀 active 自動比對 / 折價券代碼。
CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type VARCHAR(20) NOT NULL CHECK (type IN ('PERCENTAGE','FIXED_AMOUNT')),
  discount_value NUMERIC(10,4) NOT NULL,             -- PERCENTAGE: 0..1（0.9 = 9折）；FIXED_AMOUNT: 整數元
  min_threshold_type VARCHAR(20) CHECK (min_threshold_type IN ('PERIOD_COUNT')),
  min_threshold_value INTEGER,
  applicable_course_types INTEGER[],                 -- NULL = 全組別
  applicable_venue_ids VARCHAR(10)[],                -- NULL = 全場館
  coupon_code VARCHAR(40) UNIQUE,                    -- NULL = 自動套用；有值 = 需輸入代碼
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  max_uses INTEGER,
  current_uses INTEGER NOT NULL DEFAULT 0,
  platform_total_period_cap INTEGER,
  parent_period_cap INTEGER,
  current_period_uses INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_review','active','rejected','archived')),
  review_note TEXT,
  created_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_promotions_active_dates
  ON promotions(status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_promotions_coupon
  ON promotions(coupon_code) WHERE coupon_code IS NOT NULL;
DO $$ BEGIN ALTER TABLE promotions ADD COLUMN IF NOT EXISTS platform_total_period_cap INTEGER; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE promotions ADD COLUMN IF NOT EXISTS parent_period_cap INTEGER; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE promotions ADD COLUMN IF NOT EXISTS current_period_uses INTEGER NOT NULL DEFAULT 0; EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- promotion_usages：每次套用紀錄；資料隔離供日後對帳。
CREATE TABLE IF NOT EXISTS promotion_usages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE RESTRICT,
  parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  course_period_id UUID REFERENCES course_periods(id) ON DELETE CASCADE,
  original_price INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  final_price INTEGER NOT NULL,
  used_periods INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_promo_usages_promo ON promotion_usages(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promo_usages_parent ON promotion_usages(parent_id);
DO $$ BEGIN ALTER TABLE promotion_usages ADD COLUMN IF NOT EXISTS used_periods INTEGER NOT NULL DEFAULT 1; EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- 連結 LIFF 報名單（admin_enrollments.id 為 TEXT，故不設 FK）
DO $$ BEGIN ALTER TABLE promotion_usages ADD COLUMN IF NOT EXISTS admin_enrollment_id TEXT; EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_promo_usages_enrollment ON promotion_usages(admin_enrollment_id);

-- promotion_audit_logs：建立 / 送審 / 核准 / 拒絕 / 停用 軌跡
CREATE TABLE IF NOT EXISTS promotion_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL,
  by_user TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_promo_audit_promo ON promotion_audit_logs(promotion_id);

-- 通用高風險操作稽核（例如員工硬刪除）。payload 放操作明細，severity 供後台/營運快速篩選。
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

-- ─── Phase 6（下）: MGM 推薦裂變 (F-S10 / F-M10) ─────────────────────
-- 補齊家長 / 學員的可選欄位（LIFF RegisterPage 用）
DO $$ BEGIN
  ALTER TABLE parents  ADD COLUMN IF NOT EXISTS email   VARCHAR(255);
  ALTER TABLE parents  ADD COLUMN IF NOT EXISTS gender  VARCHAR(20);
  ALTER TABLE parents  ADD COLUMN IF NOT EXISTS identity VARCHAR(50);
  ALTER TABLE parents  ADD COLUMN IF NOT EXISTS home_phone VARCHAR(30);
  ALTER TABLE parents  ADD COLUMN IF NOT EXISTS home_address TEXT;
  ALTER TABLE parents  ADD COLUMN IF NOT EXISTS line_id VARCHAR(100);
  ALTER TABLE parents  ADD COLUMN IF NOT EXISTS ragic_record_id VARCHAR(50);
  -- 最後一次成功從 Ragic 同步的時間：供「開場同步」節流，並修掉 parents.js 早先引用未建欄位的潛在 bug。
  ALTER TABLE parents  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
  ALTER TABLE students ADD COLUMN IF NOT EXISTS id_number VARCHAR(20);
  ALTER TABLE students ADD COLUMN IF NOT EXISTS gender    VARCHAR(20);
  ALTER TABLE students ADD COLUMN IF NOT EXISTS blood_type VARCHAR(5);
  ALTER TABLE students ADD COLUMN IF NOT EXISTS student_code VARCHAR(50);
  ALTER TABLE students ADD COLUMN IF NOT EXISTS ragic_record_id VARCHAR(50);
  ALTER TABLE students ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE students ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
  ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_parents_ragic_record_id ON parents(ragic_record_id) WHERE ragic_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_students_id_number ON students(id_number) WHERE id_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_students_parent_active ON students(parent_id, is_active);

-- MGM 獎勵券需綁定持有者：eligible_parent_id NULL = 公開券；否則僅該家長可用
DO $$ BEGIN
  ALTER TABLE promotions
    ADD COLUMN IF NOT EXISTS eligible_parent_id UUID REFERENCES parents(id) ON DELETE CASCADE;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_promotions_eligible_parent
  ON promotions(eligible_parent_id) WHERE eligible_parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token VARCHAR(40) NOT NULL UNIQUE,
  referrer_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  referee_phone VARCHAR(20),
  referee_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','registered','trial_paid','checked_in','reward_issued')),
  experience_enrollment_id TEXT,
  reward_promotion_id UUID REFERENCES promotions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registered_at TIMESTAMPTZ,
  trial_paid_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  reward_issued_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_referrals_referee_coach
  ON referral_records(referee_phone, coach_id) WHERE referee_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referral_records(referrer_parent_id);
CREATE INDEX IF NOT EXISTS idx_referrals_coach ON referral_records(coach_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referral_records(status);

-- （已停用）原本此處在每次開機自動重建 MGM 體驗課 5 折（TRIAL50）券。
-- 2026-07：全站優惠活動清除 + 停用推薦折扣，故移除此 seed，避免刪除後開機又復活。
-- 若日後要恢復推薦體驗課折扣，重新啟用下方 INSERT 並同步恢復
-- RegisterPage.jsx 的 pendingCoupon 寫入與 enrollments.js 的 TRIAL50 驗證。
-- INSERT INTO promotions
--   (name, description, type, discount_value, applicable_course_types,
--    coupon_code, start_date, end_date, status, created_at, updated_at)
-- SELECT 'MGM 體驗課 5 折', '推薦連結專用：新客戶體驗課 5 折', 'PERCENTAGE', 0.5,
--        ARRAY[1,2,3]::INTEGER[], 'TRIAL50', CURRENT_DATE - INTERVAL '1 day',
--        CURRENT_DATE + INTERVAL '5 years', 'active', NOW(), NOW()
-- WHERE NOT EXISTS (SELECT 1 FROM promotions WHERE coupon_code = 'TRIAL50');

-- ─── Phase 7: 課程轉讓 (F-S08 / F-M04) ────────────────────────────────
-- 簡化版 transfer_records（與 001_initial_schema.sql 結構一致，但 reviewed_by 用 admin_users.id）
CREATE TABLE IF NOT EXISTS transfer_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE RESTRICT,
  from_student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  from_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  to_phone VARCHAR(20) NOT NULL,
  to_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  to_student_id UUID REFERENCES students(id) ON DELETE SET NULL,
  to_student_name VARCHAR(100),
  sessions_remaining INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','rejected','cancelled')),
  reason TEXT NOT NULL DEFAULT '',
  review_note TEXT,
  reviewed_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfer_records(status);
CREATE INDEX IF NOT EXISTS idx_transfers_from_parent ON transfer_records(from_parent_id);

-- ─── Phase 7: Cron 通知 dedupe（防重複推播）─────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(40) NOT NULL,        -- 'session_reminder_1h' / 'expiry_reminder' / 'mgm_trial_today'
  ref_id VARCHAR(80) NOT NULL,      -- session_id / period_id / referral_id
  recipient_uid VARCHAR(100) NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(kind, ref_id, recipient_uid)
);
CREATE INDEX IF NOT EXISTS idx_notif_log_kind ON notification_log(kind, sent_at DESC);

-- ─── Ragic 家長/學員識別鍵修復（P1.1 決策6/7，2026-07-07）──────────────────
-- 根治「Ragic 端電話/ID 打錯或變更 → 本地孤兒列/誤合併」：parents/students 的
-- upsert 改以 ragic_record_id 為主鍵（見 parentSync.js upsertLocalParent/
-- upsertLocalStudents），此處先確保該欄位真正具備唯一性。不同於
-- db/migrations/010_customer_family_base.sql（該檔遇重複只降級成非唯一索引、
-- 且從未被自動執行——僅能手動 npm run db:migrate，未接進開機流程），這裡先做
-- 安全去重（不刪除任何列，只解除重複列的 ragic_record_id 佔用，讓它們 fallback
-- 回 phone 識別；業務資料/FK 完全不動）再建真正的 UNIQUE，且每次開機冪等執行。
DO $$
BEGIN
  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY ragic_record_id
             ORDER BY (line_uid IS NOT NULL) DESC, updated_at DESC
           ) AS rn
      FROM parents
     WHERE ragic_record_id IS NOT NULL
  )
  UPDATE parents SET ragic_record_id = NULL, updated_at = NOW()
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  IF EXISTS (
    SELECT ragic_record_id FROM parents WHERE ragic_record_id IS NOT NULL
    GROUP BY ragic_record_id HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING '[coreSchema] parents.ragic_record_id 去重後仍有重複，略過唯一索引升級（需人工排查）';
  ELSE
    DROP INDEX IF EXISTS idx_parents_ragic_record_id;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_parents_ragic_record_id
      ON parents(ragic_record_id) WHERE ragic_record_id IS NOT NULL;
  END IF;

  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY ragic_record_id ORDER BY updated_at DESC
           ) AS rn
      FROM students
     WHERE ragic_record_id IS NOT NULL
  )
  UPDATE students SET ragic_record_id = NULL, updated_at = NOW()
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  IF EXISTS (
    SELECT ragic_record_id FROM students WHERE ragic_record_id IS NOT NULL
    GROUP BY ragic_record_id HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING '[coreSchema] students.ragic_record_id 去重後仍有重複，略過唯一索引升級（需人工排查）';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_students_ragic_record_id
      ON students(ragic_record_id) WHERE ragic_record_id IS NOT NULL;
  END IF;
END $$;

-- ─── H01 員工/教練識別鍵修復（P1.1「熊韋程 staff 事故」，2026-07-07）─────────
-- 根治跟家長端同一種病因的另一個實例：H01 同步過去以使用者可編輯的「員工編號」
-- 當比對鍵（coaches.ragic_employee_id、admin_staff.id 本身就是這個編號），Ragic
-- 端「更新系統帳號資料」動作按鈕改掉編號後，本地舊列變孤兒（line_uid 永久凍結）、
-- 新編號被誤判成新人（見 ragicAdmin.js _syncStaffImpl 註解 P1.1 決策 相關段落）。
-- 修復：改以 Ragic 真正不可變的 _ragicId 為準（欄位名沿用既有 ragic_record_id）。
-- admin_staff.ragic_record_id 欄位雖然已存在，但先前 _applyStaffChange 寫入時誤填
-- 成員工編號本身（等同 id），這裡先做安全去重（同 parents/students 手法，不刪列，
-- 只解除重複佔用）再建真正的 UNIQUE，實際的正確值由一次性回填 script 填入。
DO $$
BEGIN
  ALTER TABLE coaches ADD COLUMN IF NOT EXISTS ragic_record_id TEXT;
  ALTER TABLE coaches ADD COLUMN IF NOT EXISTS ragic_data_no TEXT;
  ALTER TABLE admin_staff ADD COLUMN IF NOT EXISTS ragic_data_no TEXT;

  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY ragic_record_id ORDER BY updated_at DESC
           ) AS rn
      FROM coaches
     WHERE ragic_record_id IS NOT NULL
  )
  UPDATE coaches SET ragic_record_id = NULL, updated_at = NOW()
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  IF EXISTS (
    SELECT ragic_record_id FROM coaches WHERE ragic_record_id IS NOT NULL
    GROUP BY ragic_record_id HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING '[coreSchema] coaches.ragic_record_id 去重後仍有重複，略過唯一索引升級（需人工排查）';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_coaches_ragic_record_id
      ON coaches(ragic_record_id) WHERE ragic_record_id IS NOT NULL;
  END IF;

  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY ragic_record_id ORDER BY updated_at DESC
           ) AS rn
      FROM admin_staff
     WHERE ragic_record_id IS NOT NULL
  )
  UPDATE admin_staff SET ragic_record_id = NULL, updated_at = NOW()
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  IF EXISTS (
    SELECT ragic_record_id FROM admin_staff WHERE ragic_record_id IS NOT NULL
    GROUP BY ragic_record_id HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING '[coreSchema] admin_staff.ragic_record_id 去重後仍有重複，略過唯一索引升級（需人工排查）';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_staff_ragic_record_id
      ON admin_staff(ragic_record_id) WHERE ragic_record_id IS NOT NULL;
  END IF;

  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY ragic_data_no ORDER BY updated_at DESC
           ) AS rn
      FROM coaches
     WHERE ragic_data_no IS NOT NULL
  )
  UPDATE coaches SET ragic_data_no = NULL, updated_at = NOW()
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  IF EXISTS (
    SELECT ragic_data_no FROM coaches WHERE ragic_data_no IS NOT NULL
    GROUP BY ragic_data_no HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING '[coreSchema] coaches.ragic_data_no 去重後仍有重複，略過唯一索引升級（需人工排查）';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_coaches_ragic_data_no
      ON coaches(ragic_data_no) WHERE ragic_data_no IS NOT NULL;
  END IF;

  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY ragic_data_no ORDER BY updated_at DESC
           ) AS rn
      FROM admin_staff
     WHERE ragic_data_no IS NOT NULL
  )
  UPDATE admin_staff SET ragic_data_no = NULL, last_synced_at = NOW()
   WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  IF EXISTS (
    SELECT ragic_data_no FROM admin_staff WHERE ragic_data_no IS NOT NULL
    GROUP BY ragic_data_no HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING '[coreSchema] admin_staff.ragic_data_no 去重後仍有重複，略過唯一索引升級（需人工排查）';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_staff_ragic_data_no
      ON admin_staff(ragic_data_no) WHERE ragic_data_no IS NOT NULL;
  END IF;

  -- admin_staff.id 修復後可能因員工編號變更而被 UPDATE（見 _applyStaffChange），
  -- admin_staff_venues 的 FK 預設只处理 ON DELETE，補上 ON UPDATE CASCADE 讓
  -- PK 值變更能連動更新，否則會撞 FK violation。只在尚未修正時才 DROP/ADD 一次。
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'admin_staff_venues_staff_id_fkey' AND confupdtype != 'c'
  ) THEN
    ALTER TABLE admin_staff_venues DROP CONSTRAINT admin_staff_venues_staff_id_fkey;
    ALTER TABLE admin_staff_venues ADD CONSTRAINT admin_staff_venues_staff_id_fkey
      FOREIGN KEY (staff_id) REFERENCES admin_staff(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 學員第三層 name+birth fallback 比對（upsertLocalStudents 內 ragic_record_id/id_number
-- 皆未命中、僅靠姓名+生日猜測是同一人）不再靜默 upsert 覆蓋既有列，改記錄待人工複核，
-- 避免同名同姓（尤其常見中文姓名）誤判成同一位學員、覆蓋錯的人的資料。
CREATE TABLE IF NOT EXISTS ragic_student_match_review (
  id BIGSERIAL PRIMARY KEY,
  parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  candidate_student_id UUID REFERENCES students(id) ON DELETE SET NULL,
  new_student_id UUID REFERENCES students(id) ON DELETE SET NULL,
  incoming_name TEXT NOT NULL,
  incoming_birth_date DATE,
  incoming_gender VARCHAR(20),
  incoming_ragic_record_id VARCHAR(50),
  incoming_id_number VARCHAR(20),
  incoming_blood_type VARCHAR(5),
  incoming_student_code VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | confirmed_same | confirmed_different | dismissed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ragic_student_match_review_pending
  ON ragic_student_match_review(status) WHERE status = 'pending';

-- ─── Ragic 影子表（P1.1 決策9，2026-07-07）────────────────────────────────
-- 職責分離：PULL 無腦寫入這裡（不比對/不清洗，只求速度），既有畢業判斷/quarantine/
-- upsert 邏輯改讀這張表而非直接呼叫 Ragic API（見 ragicAdmin.js
-- _shadowPullZ01Impl / _reconcileZ01FromShadowImpl）。raw_data 存整份 Ragic Z01
-- record 原始 JSON（含內嵌 Z02 學員子表格），與 mapZ01Parent/parseZ01Students
-- 直接吃的形狀一致，讀取端不需另外轉換。只鏡射「現況」，不留歷史：每輪 shadow-pull
-- 會刪除本次快照已不存在的舊列。
CREATE TABLE IF NOT EXISTS ragic_z01_shadow (
  ragic_record_id TEXT PRIMARY KEY,
  raw_data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ragic_z01_shadow_fetched ON ragic_z01_shadow(fetched_at);

-- H01（員工）/H05（場館）影子表：同一套「無腦 pull → 從 shadow 清洗」分工，補上
-- 決策9「所有 RAGIC 的同步都用影子表格式」原本沒收斂到的兩個表單（見 ragicAdmin.js
-- _shadowPullH01Impl/_reconcileH01FromShadowImpl、_shadowPullH05Impl/
-- _reconcileH05FromShadowImpl）。H01 key 用 ragic_record_id（真正的 _ragicId，
-- 不是可變的員工編號，理由同上方 H01 員工/教練識別鍵修復段落）；H05 場館代碼本身
-- 穩定，key 直接用代碼即可。
CREATE TABLE IF NOT EXISTS ragic_h01_shadow (
  ragic_record_id TEXT PRIMARY KEY,
  ragic_data_no TEXT,
  raw_data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE ragic_h01_shadow ADD COLUMN IF NOT EXISTS ragic_data_no TEXT;
CREATE INDEX IF NOT EXISTS idx_ragic_h01_shadow_fetched ON ragic_h01_shadow(fetched_at);
CREATE INDEX IF NOT EXISTS idx_ragic_h01_shadow_data_no ON ragic_h01_shadow(ragic_data_no);

CREATE TABLE IF NOT EXISTS ragic_h05_shadow (
  venue_code TEXT PRIMARY KEY,
  raw_data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ragic_h05_shadow_fetched ON ragic_h05_shadow(fetched_at);

-- Form 23「新生/基本資料」教練薪資倍率影子表。key 用 Ragic _ragicId；
-- reconcile 階段只允許用員工編號 + 姓名複合鍵更新 admin_staff/coaches 係數。
CREATE TABLE IF NOT EXISTS ragic_h23_shadow (
  ragic_record_id TEXT PRIMARY KEY,
  ragic_key TEXT,
  staff_emp_id TEXT,
  staff_name TEXT,
  raw_data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ragic_h23_shadow_fetched ON ragic_h23_shadow(fetched_at);
CREATE INDEX IF NOT EXISTS idx_ragic_h23_shadow_staff ON ragic_h23_shadow(staff_emp_id, staff_name);

CREATE TABLE IF NOT EXISTS ragic_webhook_log (
  id BIGSERIAL PRIMARY KEY,
  sheet_code TEXT NOT NULL,
  ragic_record_id TEXT NOT NULL,
  event_type TEXT,
  refetched BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ragic_webhook_log_sheet ON ragic_webhook_log(sheet_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ragic_webhook_log_record ON ragic_webhook_log(sheet_code, ragic_record_id, created_at DESC);

-- ─── 部署鎖死工單（launch-20260707 B 段）：Cron 單一執行權 ────────────────────
-- 四層鎖的 DB 租約層。job_locks 只存「目前持有者」單列 per job；取鎖是單一原子
-- UPSERT（見 server/cron/lock.js acquireJobLock），不用 pg_advisory_lock（連線池下
-- session 綁定不可靠，見工單 B.2 決策）。
CREATE TABLE IF NOT EXISTS job_locks (
  job_name TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  locked_until TIMESTAMPTZ NOT NULL,
  run_id UUID
);

-- 通用 run ledger（工單標註為 P1.4 的前置依賴，但翻遍 repo 沒找到既有實作，
-- 這裡當作本次任務的一部分建立）。涵蓋 server/cron/index.js 內全部 12 個排程
-- job，不只 Ragic 同步（Ragic 專屬的細節仍留在既有 ragic_sync_log，兩者不衝突、
-- 也不重複記錄——job_runs 記的是「這次排程執行本身」的起訖/持有者/狀態，
-- ragic_sync_log 記的是 Ragic 同步各表單的筆數等業務細節）。
CREATE TABLE IF NOT EXISTS job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running | success | error | skipped_lock | aborted
  triggered_by TEXT NOT NULL,             -- 'cron' | 'manual:<admin_id>'
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error_message TEXT,
  result_summary JSONB
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_name ON job_runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status) WHERE status = 'running';
`;

// 預設關鍵字清單（F-A07，可在後台增減 / 停用）
const DEFAULT_KEYWORDS = [
  { keyword: '私下', category: '私下交易' },
  { keyword: '私訊', category: '私下交易' },
  { keyword: '加 line', category: '私下交易' },
  { keyword: '私下加', category: '私下交易' },
  { keyword: '另外收費', category: '違規收費' },
  { keyword: '額外收費', category: '違規收費' },
  { keyword: '紅包', category: '違規收費' },
  { keyword: '匯款', category: '違規收費' },
  { keyword: '退費', category: '客訴風險' },
  { keyword: '投訴', category: '客訴風險' },
  { keyword: '檢舉', category: '客訴風險' },
  { keyword: '退課', category: '客訴風險' },
];

// ------ Seed dataset ------
const VENUES = [
  { id: 'B', name: '夢想體育學院 板橋館', full_address: '新北市板橋區文化路一段 188 號 3 樓' },
  { id: 'C', name: '夢想體育學院 中和館', full_address: '新北市中和區景平路 268 號 B1' },
  // 注意：Task #32 起，'X' 假館（新莊館）已移除；真實環境靠 syncVenuesFromRagic 從 H05 同步
];

const COACHES = [
  { ragic_id: 'C001', name: '王志強', phone: '0911000001', is_senior: true,  multiplier: 1.30, venues: ['B', 'C'], bio: '前國家代表隊選手，10 年青少年訓練經驗。' },
  { ragic_id: 'C002', name: '林佳穎', phone: '0911000002', is_senior: true,  multiplier: 1.50, venues: ['B'],      bio: '英國 LTA Level 3 認證教練，擅長 6-12 歲基礎培訓。' },
  { ragic_id: 'C003', name: '張嘉豪', phone: '0911000003', is_senior: false, multiplier: 1.00, venues: ['B','C'], bio: '熱情活潑、耐心十足。' },
  { ragic_id: 'C004', name: '黃詩涵', phone: '0911000004', is_senior: false, multiplier: 1.10, venues: ['C'], bio: '具備 5 年場館團體班經驗。' },
];

// demoLogin: true 的兩筆是 POST /api/auth/demo-login 依電話對應的帳密測試帳號。
// 政策（Z01 未綁殘留修正）：demo 家長一律掛 `demo:<phone>` 哨兵 line_uid ——
//  (1) 不算「未綁」→ 不會被 pull 掃尾停用、不佔後台未綁殘留檢視；
//  (2) 哨兵前綴讓 backup / 即時回寫全部略過 → demo 資料永不寫進 Ragic Z01。
const PARENTS = [
  { phone: '0912345678', name: '張媽媽', venue: 'B', demoLogin: true, students: [{ name: '張小明', birth: '2015-03-12' }, { name: '張小美', birth: '2017-08-05' }] },
  { phone: '0922333444', name: '李爸爸', venue: 'B', students: [{ name: '李小龍', birth: '2014-11-30' }] },
  { phone: '0933555777', name: '陳媽媽', venue: 'C', students: [{ name: '陳小米', birth: '2016-02-20' }] },
  // Demo 第二測試家庭（custom2 / custom2，供測「他人加入團報」）。idempotent，正式環境發布後 bootstrap 自動建立。
  { phone: '0922222222', name: '(測試帳號)家長2', venue: 'B', demoLogin: true, students: [{ name: '測試-學員A', birth: '2016-04-10' }, { name: '測試-學員B', birth: '2018-09-22' }] },
];

// 給定要建立的「期課程 + 已預約 session」demo（讓教練今日 / 排課表能看到 booked 槽位）
function relHour(daysFromToday, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(hour, minute, 0, 0);
  return d;
}

async function ensureSchema() {
  await pool.query(DDL);
}

async function seedVenuesCoachesParents() {
  for (const v of VENUES) {
    await pool.query(
      `INSERT INTO venues (id, name, full_address, is_active)
       VALUES ($1, $2, $3, TRUE) ON CONFLICT (id) DO NOTHING`,
      [v.id, v.name, v.full_address]
    );
  }
  // 冪等對齊（2026-07）：把 LIFF 用的 venues 名稱/地址對齊 F-A03 admin_venues（單一真實來源）。
  // 修正歷史殘留：早期 demo seed（DO NOTHING）先種了假地址（如 B「板橋文化路」），之後 Ragic H05
  // 只同步了「名稱」（B→新北高中），舊版 admin/venues PATCH 又漏回寫 name/full_address，導致地址卡在舊值。
  // 每次開機用當下的 admin_venues 覆蓋 venues 的名稱/地址；admin_venues 地址為空時不覆蓋（保留既有值）。
  await pool.query(
    `UPDATE venues v
        SET name = av.name,
            full_address = COALESCE(NULLIF(av.address, ''), v.full_address),
            updated_at = NOW()
       FROM admin_venues av
      WHERE av.id = v.id
        AND COALESCE(av.name, '') <> ''
        AND ( v.name IS DISTINCT FROM av.name
              OR v.full_address IS DISTINCT FROM COALESCE(NULLIF(av.address, ''), v.full_address) )`
  ).catch((e) => console.error('[venues reconcile at boot]', e.message));
  for (const c of COACHES) {
    await pool.query(
      `INSERT INTO coaches (ragic_employee_id, name, phone, is_senior, pricing_multiplier, bio_rich_text, is_active, intro_review_status)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,'published') ON CONFLICT (ragic_employee_id) DO NOTHING`,
      [c.ragic_id, c.name, c.phone, c.is_senior, c.multiplier, c.bio]
    );
    const r = await pool.query('SELECT id FROM coaches WHERE ragic_employee_id = $1', [c.ragic_id]);
    const coachUuid = r.rows[0].id;
    for (const vid of c.venues) {
      await pool.query(
        `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [coachUuid, vid]
      );
    }
  }
  const isProd = process.env.NODE_ENV === 'production';
  const demoLoginOn = process.env.ALLOW_DEMO_LOGIN === '1';
  for (const p of PARENTS) {
    // production 只允許 demo 登入帳號（且 ALLOW_DEMO_LOGIN=1 時）落地；
    // 純開發示範家庭（李爸爸/陳媽媽）只在非 production 建立，
    // 避免每次部署重啟都把示範資料塞回正式鏡像（「清了又長回來」的元凶之一）。
    const allowed = p.demoLogin ? (demoLoginOn || !isProd) : !isProd;
    if (!allowed) continue;
    // 哨兵 line_uid：只補在「從未綁定」的列上，絕不覆蓋真實 LINE 綁定。
    await pool.query(
      `INSERT INTO parents (phone, name, primary_venue_id, line_uid)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone) DO UPDATE
         SET line_uid = EXCLUDED.line_uid, is_active = TRUE, updated_at = NOW()
       WHERE parents.line_uid IS NULL OR parents.line_uid = '' OR parents.line_uid LIKE 'demo:%'`,
      [p.phone, p.name, p.venue, `demo:${p.phone}`]
    );
    const pr = await pool.query('SELECT id FROM parents WHERE phone = $1', [p.phone]);
    const parentId = pr.rows[0].id;
    for (const s of p.students) {
      const exist = await pool.query(
        `SELECT id FROM students WHERE parent_id = $1 AND name = $2`,
        [parentId, s.name]
      );
      if (exist.rows.length === 0) {
        await pool.query(
          `INSERT INTO students (parent_id, name, birth_date) VALUES ($1, $2, $3)`,
          [parentId, s.name, s.birth]
        );
      }
    }
  }
}

async function seedSlotsAndSessions() {
  // 對王志強（C001）建本週示範資料：今日已 booked 4 場 + available 4 場（教練端今日 / 週表都能看到）
  const cr = await pool.query("SELECT id FROM coaches WHERE ragic_employee_id = 'C001'");
  if (cr.rows.length === 0) return;
  const coachId = cr.rows[0].id;

  // 已存在則 skip（用第一筆當哨兵）
  const exist = await pool.query(
    `SELECT 1 FROM coach_availability_slots WHERE coach_id = $1 LIMIT 1`,
    [coachId]
  );
  if (exist.rows.length > 0) return;

  // 取家長學員 → 開一個 active period（張媽媽 + 張小明 + 王志強 1v1 板橋館）
  const parent = await pool.query("SELECT id FROM parents WHERE phone = '0912345678'");
  const student = await pool.query(
    `SELECT s.id FROM students s
     JOIN parents p ON s.parent_id = p.id
     WHERE p.phone = '0912345678' AND s.name = '張小明' LIMIT 1`
  );
  if (parent.rows.length === 0 || student.rows.length === 0) return;
  const parentId = parent.rows[0].id;
  const studentId = student.rows[0].id;

  const period = await pool.query(
    `INSERT INTO course_periods (coach_id, venue_id, course_type, total_sessions, used_sessions,
       expires_at, original_price, final_price, status)
     VALUES ($1, 'B', 1, 6, 1, (NOW() + INTERVAL '6 months')::date, 9000, 11115, 'active')
     RETURNING id`,
    [coachId]
  );
  const periodId = period.rows[0].id;
  await pool.query(
    `INSERT INTO course_period_enrollments (course_period_id, student_id, status)
     VALUES ($1, $2, 'active') ON CONFLICT DO NOTHING`,
    [periodId, studentId]
  );

  // 8 個槽位：今日 14/15 (booked)、16/17 (available)；明日 14/15 (available)、16/17 (blocked)
  // 後天 10/11 (available)
  const plan = [
    { day: 0, hour: 14, status: 'booked',    venue: 'B' },
    { day: 0, hour: 15, status: 'booked',    venue: 'B' },
    { day: 0, hour: 16, status: 'available', venue: 'B' },
    { day: 0, hour: 17, status: 'available', venue: 'B' },
    { day: 1, hour: 14, status: 'available', venue: 'B' },
    { day: 1, hour: 15, status: 'available', venue: 'B' },
    { day: 1, hour: 16, status: 'blocked',   venue: 'B' },
    { day: 2, hour: 10, status: 'available', venue: 'C' },
  ];

  for (const s of plan) {
    const startAt = relHour(s.day, s.hour);
    const slot = await pool.query(
      `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status)
       VALUES ($1, $2, $3, 60, $4) RETURNING id`,
      [coachId, s.venue, startAt.toISOString(), s.status]
    );
    if (s.status === 'booked') {
      const sess = await pool.query(
        `INSERT INTO course_sessions (course_period_id, availability_slot_id, scheduled_at, duration_minutes, status)
         VALUES ($1, $2, $3, 60, 'confirmed') RETURNING id`,
        [periodId, slot.rows[0].id, startAt.toISOString()]
      );
      await pool.query(
        `UPDATE coach_availability_slots SET booked_session_id = $1 WHERE id = $2`,
        [sess.rows[0].id, slot.rows[0].id]
      );
    }
  }
  console.log('[core bootstrap] seeded coaches + venues + parents + 8 demo slots for C001');
}

// Phase 5 — 預設標籤庫（F-A08；5 大類，含「備註」快速提醒，降低教練填寫摩擦）
const DEFAULT_TAG_CATEGORIES = [
  { name: '表現亮點',
    tags: [
      { label: '專注度高', text: '本堂上課專注度高，能全程跟上節奏。' },
      { label: '進步明顯', text: '相較上堂課，技術動作有明顯進步。' },
      { label: '主動發問', text: '能主動發問並嘗試各種變化。' },
      { label: '團隊默契佳', text: '與同組學員配合度佳，團隊默契良好。' },
    ]},
  { name: '需加強',
    tags: [
      { label: '握拍偏緊', text: '握拍仍偏緊，下一堂建議放鬆手腕並重複正手揮拍練習。' },
      { label: '步伐慢半拍', text: '步伐稍慢半拍，建議加強左右側併步移動。' },
      { label: '專注度待提升', text: '中段有些分心，下堂課將安排短回合互動以維持專注。' },
      { label: '回擊節奏不穩', text: '回擊節奏尚不穩定，將以多球練習穩定動作。' },
    ]},
  { name: '回家練習',
    tags: [
      { label: '揮拍 30 下', text: '回家練習正手揮拍 30 下 × 2 組。' },
      { label: '對牆球', text: '可在家對牆練習控球 5 分鐘。' },
      { label: '核心訓練', text: '加強核心：平板支撐 30 秒 × 3 組。' },
      { label: '柔軟度', text: '記得拉筋與肩膀柔軟度練習，預防運動傷害。' },
    ]},
  { name: '上課摘要',
    tags: [
      { label: '基本動作', text: '本堂以基本動作（握拍 / 站姿 / 揮拍軌跡）為主。' },
      { label: '正反手對抽', text: '本堂進行正反手對抽訓練，含定點與移位變化。' },
      { label: '發球練習', text: '本堂安排發球練習，含上手 / 下手與站位調整。' },
      { label: '對打模擬', text: '後段進行對打模擬，鍛鍊比賽情境應變能力。' },
    ]},
  { name: '備註',
    tags: [
      { label: '備註b', text: '備註：本堂狀況穩定，後續依課程進度持續調整練習內容。' },
      { label: '請帶水壺', text: '提醒：下堂課請自備水壺與毛巾。' },
      { label: '請假補課', text: '本堂如需請假，請提前於 LINE 告知以利安排補課。' },
      { label: '攜帶裝備', text: '下堂課請記得攜帶個人球拍與運動鞋。' },
      { label: '家長配合', text: '請家長協助孩子於課後完成回家練習，效果更佳。' },
    ]},
];

const DEFAULT_THRESHOLDS = [
  { metric: 'avg_overall',  min_value: 4.00, window_months: 3 },
  { metric: 'avg_teaching', min_value: 4.00, window_months: 3 },
  { metric: 'renew_rate',   min_value: 0.60, window_months: 3 },
];

async function seedCourseTypeConfigs() {
  // 商品品相＝乾淨的 1對1 ～ 1對6 系列（每張卡片＝一個師生比級距，max_students=編號、min_students=1）。
  // base_price 為每人每期單價佔位（沿用遞減趨勢），實際價格由後台「課程需求管理」(F-A07) 維護。
  const defaults = [
    { course_type: 1, label: '一對一', max_students: 1, min_students: 1, sort_order: 1, base_price: 9000 },
    { course_type: 2, label: '一對二', max_students: 2, min_students: 1, sort_order: 2, base_price: 6000 },
    { course_type: 3, label: '一對三', max_students: 3, min_students: 1, sort_order: 3, base_price: 4500 },
    { course_type: 4, label: '1對4',   max_students: 4, min_students: 1, sort_order: 4, base_price: 3000 },
    { course_type: 5, label: '1對5',   max_students: 5, min_students: 1, sort_order: 5, base_price: 3000 },
    { course_type: 6, label: '1對6',   max_students: 6, min_students: 1, sort_order: 6, base_price: 3000 },
  ];
  for (const d of defaults) {
    await pool.query(
      `INSERT INTO course_type_configs (course_type, label, max_students, min_students, sort_order, base_price)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (course_type) DO UPDATE SET base_price = EXCLUDED.base_price
       WHERE course_type_configs.base_price = 0`,
      [d.course_type, d.label, d.max_students, d.min_students, d.sort_order, d.base_price]
    );
  }
  // 既有環境一次性升級：把舊的「1對4~6」團體班(min4/max6)拆成乾淨的「1對4」(min1/max4)。
  // 僅在仍為舊 seed 設定時才動，避免覆蓋後台已自訂的 label／人數。
  await pool.query(
    `UPDATE course_type_configs
        SET label = '1對4', max_students = 4, min_students = 1, updated_at = NOW()
      WHERE course_type = 4 AND label = '1對4~6'`
  );
  // 課程介紹（家長端商品品項來源）：為 4／5／6 補一筆預設介紹（title 取 config label、body／圖留白，
  // 由後台「課程介紹維護」逐步填入）；已存在則不覆蓋，尊重後台自訂。
  await pool.query(
    `INSERT INTO admin_course_intros (course_type, title, body, image_url, title_overridden)
     SELECT c.course_type, c.label, '', '', FALSE
       FROM course_type_configs c
      WHERE c.course_type IN (4, 5, 6)
     ON CONFLICT (course_type) DO NOTHING`
  );
  // 既有「1對4~6」介紹標題、且未被後台覆寫者，一併更新為「1對4」。
  await pool.query(
    `UPDATE admin_course_intros
        SET title = '1對4', updated_at = NOW()
      WHERE course_type = 4 AND title = '1對4~6' AND title_overridden = FALSE`
  );
}

// 註：原本的「團報人數全域夾擠」(normalizeCourseTypeBounds) 已依需求移除——
// course_type_configs 的 min/max/啟用狀態完全以後台「課程需求管理」為準，開機不再夾擠覆寫。
// 對應 groupOrders.js effectiveBounds() 也已放寬為僅結構性防呆。

async function seedTagsAndThresholds() {
  for (const cat of DEFAULT_TAG_CATEGORIES) {
    await pool.query(
      `INSERT INTO tag_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [cat.name]
    );
    const c = await pool.query(`SELECT id FROM tag_categories WHERE name = $1`, [cat.name]);
    if (c.rows.length === 0) continue;
    for (const t of cat.tags) {
      await pool.query(
        `INSERT INTO tag_library (category_id, label, text_template)
         VALUES ($1, $2, $3) ON CONFLICT (category_id, label) DO NOTHING`,
        [c.rows[0].id, t.label, t.text]
      );
    }
  }
  for (const th of DEFAULT_THRESHOLDS) {
    await pool.query(
      `INSERT INTO eval_thresholds (metric, min_value, window_months, is_active)
       VALUES ($1, $2, $3, TRUE) ON CONFLICT (metric) DO NOTHING`,
      [th.metric, th.min_value, th.window_months]
    );
  }
}

async function seedKeywords() {
  for (const k of DEFAULT_KEYWORDS) {
    await pool.query(
      `INSERT INTO keyword_list (keyword, category, is_active)
       VALUES ($1, $2, TRUE) ON CONFLICT (keyword) DO NOTHING`,
      [k.keyword, k.category]
    );
  }
}

// 確保所有 active 的 course_periods 都有對應 chat_room（向前相容）
async function ensureChatRoomsForActivePeriods() {
  await pool.query(`
    INSERT INTO chat_rooms (course_period_id)
    SELECT cp.id FROM course_periods cp
    LEFT JOIN chat_rooms cr ON cr.course_period_id = cp.id
    WHERE cp.status = 'active' AND cr.id IS NULL
    ON CONFLICT (course_period_id) DO NOTHING
  `);
}

// Task #67：等 course_type_configs 已存在所有 intros 對應的 course_type 後，加上 FK 與 cascade
async function ensureCourseIntroFK() {
  // 補齊缺失的 course_type_configs（避免 FK 失敗：例如歷史 intro 4 但沒對應 config）
  await pool.query(`
    INSERT INTO course_type_configs (course_type, label, max_students, sort_order)
    SELECT i.course_type, COALESCE(NULLIF(i.title, ''), '一對' || i.course_type), i.course_type, i.course_type
      FROM admin_course_intros i
      LEFT JOIN course_type_configs c ON c.course_type = i.course_type
     WHERE c.course_type IS NULL
    ON CONFLICT (course_type) DO NOTHING
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE admin_course_intros
        ADD CONSTRAINT fk_admin_course_intros_course_type
        FOREIGN KEY (course_type) REFERENCES course_type_configs(course_type) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
}

async function purgeZ03OnceForProductionPublish() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [Z03_PURGE_SETTING_KEY]);

    const tables = await client.query(
      `SELECT
         to_regclass('public.admin_settings') AS admin_settings,
         to_regclass('public.ragic_z03_records') AS z03_records,
         to_regclass('public.ragic_z03_students') AS z03_students`
    );
    const row = tables.rows[0] || {};
    if (!row.admin_settings || !row.z03_records) {
      await client.query('ROLLBACK');
      return;
    }

    const done = await client.query(
      `SELECT 1 FROM admin_settings WHERE key = $1 LIMIT 1`,
      [Z03_PURGE_SETTING_KEY]
    );
    if (done.rowCount) {
      await client.query('COMMIT');
      return;
    }

    let deletedOrphanStudents = 0;
    if (row.z03_students) {
      const orphanStudents = await client.query(
        `DELETE FROM ragic_z03_students s
          WHERE NOT EXISTS (SELECT 1 FROM ragic_z03_records r WHERE r.id = s.z03_record_id)
          RETURNING id`
      );
      deletedOrphanStudents = orphanStudents.rowCount;
    }

    const deletedRecords = await client.query(`DELETE FROM ragic_z03_records RETURNING id`);
    await client.query(
      `INSERT INTO admin_settings (key, value, updated_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = 1, updated_at = NOW()`,
      [Z03_PURGE_SETTING_KEY]
    );
    await client.query('COMMIT');
    console.log(
      '[core bootstrap] one-time hard purged local Z03: records=%d orphan_students=%d',
      deletedRecords.rowCount,
      deletedOrphanStudents
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function clearLegacyStagingChanges() {
  // Staging 流程已下架（H01/H05 sync 改為直接 apply）。
  // 每次啟動一律清空舊的待審核列，確保不留遺留資料干擾。
  try {
    const r = await pool.query(`DELETE FROM ragic_staging_changes`);
    if (r.rowCount > 0) {
      console.log(`[core bootstrap] cleared ${r.rowCount} legacy ragic_staging_changes rows`);
    }
  } catch (err) {
    console.warn('[core bootstrap] clearLegacyStagingChanges skipped:', err.message);
  }
}

async function bootstrap() {
  try {
    await ensureSchema();
    await clearLegacyStagingChanges();
    await purgeZ03OnceForProductionPublish();
    await seedVenuesCoachesParents();
    await seedSlotsAndSessions();
    await seedKeywords();
    await seedTagsAndThresholds();
    await seedCourseTypeConfigs();
    await ensureCourseIntroFK();
    await ensureChatRoomsForActivePeriods();
    console.log('[core bootstrap] ready');
  } catch (err) {
    console.error('[core bootstrap] FAILED:', err.message);
    throw err;
  }
}

module.exports = { bootstrap };
