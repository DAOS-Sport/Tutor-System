-- U13 雙軌簽到（additive）：新系統上線初期，許多舊生與教練沒有「先排課再簽到」的
-- 習慣。新增期別層級開關 checkin_mode：
--   'booking'（預約制，預設）—— 行為與現行完全相同。
--   'self'（免預約自助簽到）—— 家長按「今日上課簽到」當下自動補建一堂當日課堂
--     （course_sessions.created_via='self_checkin'）＋勾選學員的簽到紀錄；
--     堂數計算、教練紀錄、學習歷程、報表全部沿用既有資料路徑。
-- 防呆：同一期每日限一次自助簽到，由 partial unique index 硬保證（雙擊/重送/
-- 多裝置並發皆擋）；堂數上限沿用「非取消課堂數 >= total_sessions 擋」。
-- 家長不可自行撤銷；櫃檯撤銷（admin API）會清 self_checkin_date（釋放當日名額）
-- 並把課堂轉 cancelled_normal；新版 reversal 只標記 attendance、不刪除歷史，全程 audit。

ALTER TABLE course_periods ADD COLUMN IF NOT EXISTS checkin_mode TEXT NOT NULL DEFAULT 'booking';
DO $$ BEGIN
  ALTER TABLE course_periods ADD CONSTRAINT chk_course_periods_checkin_mode
    CHECK (checkin_mode IN ('booking','self'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE course_sessions ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'booking';
ALTER TABLE course_sessions ADD COLUMN IF NOT EXISTS self_checkin_date DATE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_self_checkin_daily
  ON course_sessions(course_period_id, self_checkin_date)
  WHERE created_via = 'self_checkin' AND self_checkin_date IS NOT NULL;
