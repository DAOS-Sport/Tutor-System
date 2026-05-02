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

CREATE TABLE IF NOT EXISTS parents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_uid VARCHAR(100) UNIQUE,
  phone VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  primary_venue_id VARCHAR(10) REFERENCES venues(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL,
  birth_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
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
DO $$ BEGIN ALTER TABLE coach_availability_slots ADD COLUMN IF NOT EXISTS notes TEXT; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE coach_availability_slots ADD COLUMN IF NOT EXISTS booked_session_id UUID; EXCEPTION WHEN undefined_table THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS checkin_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_session_id UUID NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  is_auto_linked BOOLEAN NOT NULL DEFAULT FALSE,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_session_id, student_id)
);

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
  status VARCHAR(10) NOT NULL DEFAULT 'draft', -- draft | submitted
  media JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ url, mime, name, size }]
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
  { id: 'X', name: '夢想體育學院 新莊館', full_address: '新北市新莊區中正路 10 號 2 樓' },
];

const COACHES = [
  { ragic_id: 'C001', name: '王志強', phone: '0911000001', is_senior: true,  multiplier: 1.30, venues: ['B', 'C'], bio: '前國家代表隊選手，10 年青少年訓練經驗。' },
  { ragic_id: 'C002', name: '林佳穎', phone: '0911000002', is_senior: true,  multiplier: 1.50, venues: ['B'],      bio: '英國 LTA Level 3 認證教練，擅長 6-12 歲基礎培訓。' },
  { ragic_id: 'C003', name: '張嘉豪', phone: '0911000003', is_senior: false, multiplier: 1.00, venues: ['B','C','X'], bio: '熱情活潑、耐心十足。' },
  { ragic_id: 'C004', name: '黃詩涵', phone: '0911000004', is_senior: false, multiplier: 1.10, venues: ['C', 'X'], bio: '具備 5 年場館團體班經驗。' },
];

const PARENTS = [
  { phone: '0912345678', name: '張媽媽', venue: 'B', students: [{ name: '張小明', birth: '2015-03-12' }, { name: '張小美', birth: '2017-08-05' }] },
  { phone: '0922333444', name: '李爸爸', venue: 'B', students: [{ name: '李小龍', birth: '2014-11-30' }] },
  { phone: '0933555777', name: '陳媽媽', venue: 'C', students: [{ name: '陳小米', birth: '2016-02-20' }] },
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
  for (const p of PARENTS) {
    await pool.query(
      `INSERT INTO parents (phone, name, primary_venue_id) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING`,
      [p.phone, p.name, p.venue]
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

// Phase 5 — 預設標籤庫（F-A08；4 大類 × 4 標籤）
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
];

const DEFAULT_THRESHOLDS = [
  { metric: 'avg_overall',  min_value: 4.00, window_months: 3 },
  { metric: 'avg_teaching', min_value: 4.00, window_months: 3 },
  { metric: 'renew_rate',   min_value: 0.60, window_months: 6 },
];

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

async function bootstrap() {
  try {
    await ensureSchema();
    await seedVenuesCoachesParents();
    await seedSlotsAndSessions();
    await seedKeywords();
    await seedTagsAndThresholds();
    await ensureChatRoomsForActivePeriods();
    console.log('[core bootstrap] ready');
  } catch (err) {
    console.error('[core bootstrap] FAILED:', err.message);
    throw err;
  }
}

module.exports = { bootstrap };
