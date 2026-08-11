-- =====================================================================
-- dev_seed_coach_ui.sql 的一鍵清除
-- =====================================================================
-- 只刪本種子建立的東西：UUID 以 `5eed` 開頭、admin_enrollments.id 以 `ESEED-` 開頭。
-- 不碰 demo_seed_prod.sql 建立的資料，也不碰任何非種子資料。
--
-- 執行（DEV only，開頭同樣有 heliumdb 守門）：
--   psql "$DATABASE_URL" -f server/scripts/dev_cleanup_coach_ui.sql
--
-- 註：course_sessions / course_period_enrollments / session_records / lesson_plans /
--     checkin_records 對 course_periods 都是 ON DELETE CASCADE，所以刪掉三個
--     course_period 就會連帶清乾淨，不必逐張刪。
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_db TEXT := current_database();
BEGIN
  IF v_db <> 'heliumdb' THEN
    RAISE EXCEPTION '這份 cleanup 只能在 DEV（heliumdb）執行，目前資料庫是 %。已中止。', v_db;
  END IF;

  -- 訂單（含團報四列）
  DELETE FROM admin_enrollments WHERE id LIKE 'ESEED-%';

  -- 課期（CASCADE 掉課堂、名冊、簽到、授課記錄、課前規劃）
  DELETE FROM course_periods WHERE id::text LIKE '5eed%';

  -- 團報
  DELETE FROM group_order_members WHERE group_order_id::text LIKE '5eed%';
  DELETE FROM group_orders        WHERE id::text LIKE '5eed%';

  -- 介紹圖片
  DELETE FROM coach_bio_media WHERE id::text LIKE '5eed%';

  -- 個人頁狀態還原成種子執行前的樣子（退回原因清掉、狀態回 draft）
  UPDATE coaches
     SET intro_review_status = 'draft',
         intro_review_note   = NULL,
         intro_reviewed_at   = NULL
   WHERE name = '(測試帳號)教練'
     AND intro_review_note LIKE '（測試）%';

  -- 註：admin_staff_venues 的兩列不刪 —— 那是「這位教練可教哪些館」的設定，
  -- 不是本種子獨有的測試資料，刪掉會讓既有測試流程少一個館。

  RAISE NOTICE 'dev_cleanup_coach_ui 完成';
END $$;

COMMIT;
