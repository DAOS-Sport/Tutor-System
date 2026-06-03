-- Migration 005: 學習歷程 + 期末評鑑 + 標籤庫 + 考核門檻 + 教練介紹送審
-- F-C04 / F-C05 / F-S06 / F-S12 / F-M09 / F-A08 / F-A09 / F-C06
-- Idempotent — 與 server/bootstrap/coreSchema.js 保持一致；可在 prod 重跑。
-- Run: psql $DATABASE_URL -f db/migrations/005_learning_history.sql
--
-- ── 升級舊版（001_initial_schema.sql）：對應表已存在但欄位不同 ────────
-- 1) session_records：舊版欄位 content_summary/performance_evaluation/...
--    新版改為 summary/highlights/improvements/homework + coach_id +
--    course_period_id + media JSONB + status('draft'|'submitted')。
DO $$ BEGIN
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS course_period_id UUID REFERENCES course_periods(id) ON DELETE CASCADE;
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaches(id) ON DELETE RESTRICT;
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS highlights TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS improvements TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS homework TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE session_records ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
  -- 舊欄位保留（回填遷移由業務面負責），status 改為 VARCHAR 以支援新值。
  BEGIN
    ALTER TABLE session_records ALTER COLUMN status TYPE VARCHAR(10) USING status::text;
    ALTER TABLE session_records ALTER COLUMN status SET DEFAULT 'draft';
  EXCEPTION WHEN others THEN NULL; END;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_records_period ON session_records(course_period_id);

-- 2) session_record_versions：舊版 version_number + content_snapshot；
--    新版改 version_no + snapshot + edited_by。為相容兩種寫法都新增欄位，
--    並讓兩組欄位都可 NULL（程式只寫新欄位）。
DO $$ BEGIN
  ALTER TABLE session_record_versions ADD COLUMN IF NOT EXISTS version_no INTEGER;
  ALTER TABLE session_record_versions ADD COLUMN IF NOT EXISTS snapshot JSONB;
  ALTER TABLE session_record_versions ADD COLUMN IF NOT EXISTS edited_by UUID REFERENCES coaches(id) ON DELETE RESTRICT;
  ALTER TABLE session_record_versions ALTER COLUMN version_number DROP NOT NULL;
  ALTER TABLE session_record_versions ALTER COLUMN content_snapshot DROP NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_session_record_versions_no
    ON session_record_versions(session_record_id, version_no);
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- 3) session_record_tags：舊版為 (id, tag_category, tag_text, ...) 含資料表
--    結構衝突；新版以 (session_record_id, label) 為 PK 並關聯 tag_library /
--    coach_personal_tags。若偵測到舊欄位 tag_text，安全 DROP 重建（舊資料
--    與新流程不相容；F-C05 從 phase 5 才正式啟用）。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'session_record_tags' AND column_name = 'tag_text'
  ) THEN
    DROP TABLE session_record_tags CASCADE;
  END IF;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- 4) course_evaluations：舊版欄位 teaching_quality / communication_attitude /
--    student_progress / overall_satisfaction / text_feedback / renew_intention
--    新版改 score_teaching/score_attitude/score_progress/score_overall +
--    comment + renew_intent + coach_id。新增欄位 + 從舊欄位回填。
DO $$ BEGIN
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS coach_id UUID REFERENCES coaches(id) ON DELETE RESTRICT;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS score_teaching INTEGER;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS score_attitude INTEGER;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS score_progress INTEGER;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS score_overall INTEGER;
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS comment TEXT NOT NULL DEFAULT '';
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS renew_intent VARCHAR(10) NOT NULL DEFAULT 'unknown';
  ALTER TABLE course_evaluations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- 從舊欄位回填（僅在新欄位為 NULL 時複寫）
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
  -- 從 course_periods 補 coach_id
  UPDATE course_evaluations ce SET coach_id = cp.coach_id
    FROM course_periods cp
   WHERE ce.coach_id IS NULL AND ce.course_period_id = cp.id;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_eval_coach ON course_evaluations(coach_id);
CREATE INDEX IF NOT EXISTS idx_eval_submitted ON course_evaluations(submitted_at);

-- ── 標籤庫 (F-A08) ──
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
  text_template TEXT NOT NULL,
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

-- ── 課前規劃 (F-C04) ──
CREATE TABLE IF NOT EXISTS lesson_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  goals TEXT NOT NULL DEFAULT '',
  expected_outcomes TEXT NOT NULL DEFAULT '',
  learning_plan TEXT NOT NULL DEFAULT '',
  initial_assessment TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_period_id)
);

-- ── 授課記錄 (F-C05) + 版本歷史 ──
CREATE TABLE IF NOT EXISTS session_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_session_id UUID NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  summary TEXT NOT NULL DEFAULT '',
  highlights TEXT NOT NULL DEFAULT '',
  improvements TEXT NOT NULL DEFAULT '',
  homework TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'draft',
  media JSONB NOT NULL DEFAULT '[]'::jsonb,
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
  snapshot JSONB NOT NULL,
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

-- ── 期末評鑑 (F-S12 / F-M09) ──
CREATE TABLE IF NOT EXISTS course_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_period_id UUID NOT NULL REFERENCES course_periods(id) ON DELETE CASCADE,
  parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reminder_sent_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  score_teaching INTEGER,
  score_attitude INTEGER,
  score_progress INTEGER,
  score_overall INTEGER,
  comment TEXT NOT NULL DEFAULT '',
  renew_intent VARCHAR(10) NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_period_id, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_eval_coach ON course_evaluations(coach_id);
CREATE INDEX IF NOT EXISTS idx_eval_submitted ON course_evaluations(submitted_at);

-- ── 考核門檻 (F-A09) ──
CREATE TABLE IF NOT EXISTS eval_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric VARCHAR(40) NOT NULL UNIQUE,
  min_value NUMERIC(5,2) NOT NULL,
  window_months INTEGER NOT NULL DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eval_threshold_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  metric VARCHAR(40) NOT NULL,
  observed_value NUMERIC(5,2),
  min_value NUMERIC(5,2) NOT NULL,
  window_months INTEGER NOT NULL,
  period_month CHAR(7) NOT NULL,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(coach_id, metric, period_month)
);
CREATE INDEX IF NOT EXISTS idx_eval_alerts_pending ON eval_threshold_alerts(notified_at) WHERE notified_at IS NULL;

-- ── 教練介紹送審 (F-C06)：擴充 coaches 欄位 ──
DO $$ BEGIN
  ALTER TABLE coaches ADD COLUMN IF NOT EXISTS intro_review_status VARCHAR(20) NOT NULL DEFAULT 'draft';
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE coaches ADD COLUMN IF NOT EXISTS intro_review_note TEXT;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
-- legacy 升級：早期 coach 端寫入 'submitted'，admin 端期望 'pending_review'
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

-- ── 預設種子（idempotent；給「只跑 SQL migration、不跑 bootstrap」的部署環境）──
INSERT INTO tag_categories (name) VALUES
  ('表現亮點'),('需加強'),('回家練習'),('上課摘要'),('備註')
ON CONFLICT (name) DO NOTHING;

INSERT INTO tag_library (category_id, label, text_template)
SELECT c.id, v.label, v.text_template FROM (VALUES
  ('表現亮點','專注度高','本堂上課專注度高，能全程跟上節奏。'),
  ('表現亮點','進步明顯','相較上堂課，技術動作有明顯進步。'),
  ('表現亮點','主動發問','能主動發問並嘗試各種變化。'),
  ('表現亮點','團隊默契佳','與同組學員配合度佳，團隊默契良好。'),
  ('需加強','握拍偏緊','握拍仍偏緊，下一堂建議放鬆手腕並重複正手揮拍練習。'),
  ('需加強','步伐慢半拍','步伐稍慢半拍，建議加強左右側併步移動。'),
  ('需加強','專注度待提升','中段有些分心，下堂課將安排短回合互動以維持專注。'),
  ('需加強','回擊節奏不穩','回擊節奏尚不穩定，將以多球練習穩定動作。'),
  ('回家練習','揮拍 30 下','回家練習正手揮拍 30 下 × 2 組。'),
  ('回家練習','對牆球','可在家對牆練習控球 5 分鐘。'),
  ('回家練習','核心訓練','加強核心：平板支撐 30 秒 × 3 組。'),
  ('回家練習','柔軟度','記得拉筋與肩膀柔軟度練習，預防運動傷害。'),
  ('上課摘要','基本動作','本堂以基本動作（握拍 / 站姿 / 揮拍軌跡）為主。'),
  ('上課摘要','正反手對抽','本堂進行正反手對抽訓練，含定點與移位變化。'),
  ('上課摘要','發球練習','本堂安排發球練習，含上手 / 下手與站位調整。'),
  ('上課摘要','對打模擬','後段進行對打模擬，鍛鍊比賽情境應變能力。'),
  ('備註','請帶水壺','提醒：下堂課請自備水壺與毛巾。'),
  ('備註','請假補課','本堂如需請假，請提前於 LINE 告知以利安排補課。')
) AS v(cat_name, label, text_template)
JOIN tag_categories c ON c.name = v.cat_name
ON CONFLICT (category_id, label) DO NOTHING;

INSERT INTO eval_thresholds (metric, min_value, window_months, is_active) VALUES
  ('avg_overall',  4.00, 3, TRUE),
  ('avg_teaching', 4.00, 3, TRUE),
  ('renew_rate',   0.60, 3, TRUE)
ON CONFLICT (metric) DO NOTHING;
