-- 家庭共班（additive）：同一家長多位學員報名一對二以上課程時，家長端訂單按
-- 「學員 × 期數」拆成多筆 admin_enrollments（共用 enrollment_batch_id）。這些
-- 兄弟訂單實體上是「同一班、同一期」，對帳開通時必須共用「一個」course_period
-- （全班共用同一堂數池），否則會膨脹成每位小孩各自一期（3 位小孩 × 6 堂 = 18 堂）。
-- 此欄位供開通橋以 (enrollment_batch_id, period_number) 冪等 get-or-create。
-- 一對一或單學員報名維持 NULL（沿用 admin_enrollment_id 冪等，行為不變）。
ALTER TABLE course_periods ADD COLUMN IF NOT EXISTS enrollment_batch_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_course_periods_batch_period
  ON course_periods(enrollment_batch_id, period_number)
  WHERE enrollment_batch_id IS NOT NULL;

-- 既有錯誤資料（同批同期多個 period）不在此 migration 內合併；
-- 由 scripts/merge_family_shared_periods.js 以 dry-run → execute 兩段式修復。

-- 全站統一台灣時區的最後一道防線：資料庫預設時區設為 Asia/Taipei。
-- 應用層已覆蓋（Node TZ / pool 每連線 SET TIME ZONE / cron timezone），
-- 此設定補上維運 script、psql、測試等「裸連線」的日期邊界運算。
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Taipei');
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '設定資料庫預設時區 Asia/Taipei 失敗（需 owner 權限）: %', SQLERRM;
END $$;
