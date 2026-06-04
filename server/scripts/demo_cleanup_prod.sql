-- =====================================================================
-- DAOS DEMO 測試資料 一鍵清除（正式 DB 用）
-- =====================================================================
-- 用途：測試結束後，移除 demo_seed_prod.sql 建立的所有 demo 測試資料，
--       含測試期間實際操作產生的衍生資料（換教練、轉讓、上課紀錄、簽到等）。
--
-- 安全特性：
--   * 只刪除帶標記的測試資料：
--       - 教練：coaches.name IN ('(測試帳號)教練','(測試帳號)教練2')
--       - 家長：parents.phone IN ('0912345678','0922222222')
--                或 parents.name LIKE '(測試帳號)%' 或 line_uid LIKE 'DEMOTEST_%'
--   * 依 FK 相依順序刪除 + 對循環/NO ACTION FK 先設 NULL，避免衝突。
--   * 場館 B 轉帳帳號「只在等於測試值時」還原為空，不動正式帳號。
--   * 不刪除其他既有 (測試帳號) 行政/櫃台帳號（非本 seed 建立）。
--
-- 執行：psql "$PROD_DATABASE_URL" -f server/scripts/demo_cleanup_prod.sql
-- =====================================================================

BEGIN;

-- ── 共用篩選（重複內嵌，psql 無法跨語句共享 CTE）───────────────────────
--   測試教練：coaches.name IN ('(測試帳號)教練','(測試帳號)教練2')
--   測試家長：phone IN (...) OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%'
--   測試課程期：course_periods.coach_id IN 測試教練
--   測試學員：students.parent_id IN 測試家長

-- 0) 先打破會「擋刪除」的 FK（NO ACTION / RESTRICT，非 CASCADE）：
--    a. course_sessions ↔ coach_availability_slots 循環參考
--    b. course_sessions.coach_id（換教練後可能指向測試教練、但其課程期非測試期）
--    c. course_sessions.initiated_by_parent_id（家長發起的課堂，NO ACTION）
UPDATE course_sessions SET availability_slot_id = NULL
 WHERE course_period_id IN (SELECT id FROM course_periods WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2')))
    OR availability_slot_id IN (SELECT id FROM coach_availability_slots WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2')));
UPDATE coach_availability_slots SET booked_session_id = NULL
 WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'));
UPDATE course_sessions SET coach_id = NULL
 WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'));
UPDATE course_sessions SET initiated_by_parent_id = NULL
 WHERE initiated_by_parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%');

-- 1) 轉讓紀錄（transfer_records 多個 RESTRICT FK：parent/student/period，須最先刪）
DELETE FROM transfer_records
 WHERE from_parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%')
    OR to_parent_id   IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%')
    OR from_student_id IN (SELECT id FROM students WHERE parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%'))
    OR to_student_id   IN (SELECT id FROM students WHERE parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%'))
    OR course_period_id IN (SELECT id FROM course_periods WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2')));

-- 2) 簽到紀錄（student_id RESTRICT；測試 session 或測試學員皆刪）
DELETE FROM checkin_records
 WHERE course_session_id IN (SELECT id FROM course_sessions WHERE course_period_id IN (SELECT id FROM course_periods WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'))))
    OR student_id IN (SELECT id FROM students WHERE parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%'));

-- 3) 評鑑 / 課程計畫 / 上課紀錄（course_period CASCADE，但顯式刪除更明確）
DELETE FROM course_evaluations
 WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'))
    OR parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%')
    OR course_period_id IN (SELECT id FROM course_periods WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2')));

DELETE FROM lesson_plans
 WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'))
    OR course_period_id IN (SELECT id FROM course_periods WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2')));

-- session_records 經 course_period_id / course_session_id CASCADE 自動清除；
-- 此處再依 coach_id（RESTRICT）顯式刪一次，涵蓋換教練後殘留的邊角資料。
DELETE FROM session_records
 WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'))
    OR course_period_id IN (SELECT id FROM course_periods WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2')));

-- 4) 時段 / 課堂（cross-ref 已於 step 0 設 NULL）
DELETE FROM coach_availability_slots
 WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'));

DELETE FROM course_sessions
 WHERE course_period_id IN (SELECT id FROM course_periods WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2')));

DELETE FROM course_period_enrollments
 WHERE course_period_id IN (SELECT id FROM course_periods WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2')))
    OR student_id IN (SELECT id FROM students WHERE parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%'));

-- 5) 團購（members 經 CASCADE，顯式刪除更明確）
DELETE FROM group_order_members
 WHERE parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%')
    OR group_order_id IN (SELECT id FROM group_orders WHERE leader_parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%'));

DELETE FROM group_orders
 WHERE leader_parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%')
    OR coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'))
    OR join_token = 'demotestgroup3invite0001';

DELETE FROM group_order_drafts
 WHERE parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%');

-- 5b) 後台報名單（家長報名流程產生；以去正規化欄位 marker-scope；audit_logs CASCADE）
DELETE FROM admin_enrollments
 WHERE parent_phone IN ('0912345678','0922222222')
    OR parent_name LIKE '(測試帳號)%'
    OR coach IN ('(測試帳號)教練','(測試帳號)教練2');

-- 5c) 推薦紀錄（FK 多為 CASCADE/SET NULL，刪 parents/coaches 會自動處理；
--     此處顯式 marker-scope 刪除以涵蓋舊 schema FK 較嚴格的環境，並清乾淨測試推薦資料）
DELETE FROM referral_records
 WHERE referrer_parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%')
    OR referee_parent_id  IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%')
    OR coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'));

-- 6) 課程期（相依子表已清空）
DELETE FROM course_periods
 WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'));

-- 7) 學員（parents 刪除前必清，students.parent_id RESTRICT）
DELETE FROM students
 WHERE parent_id IN (SELECT id FROM parents WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%');

-- 8) 教練場館對應 + 後台教練帳號（只刪本 seed 建立的兩個 coach 帳號）
DELETE FROM coach_venues
 WHERE coach_id IN (SELECT id FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2'));
DELETE FROM admin_staff_venues WHERE staff_id IN ('0605065','0605066');
DELETE FROM admin_staff        WHERE id       IN ('0605065','0605066');

-- 9) 教練主檔 / 家長主檔
DELETE FROM coaches WHERE name IN ('(測試帳號)教練','(測試帳號)教練2');
DELETE FROM parents
 WHERE phone IN ('0912345678','0922222222') OR name LIKE '(測試帳號)%' OR line_uid LIKE 'DEMOTEST_%';

-- 10) 場館 B 轉帳帳號：只有等於測試值時才還原為空（不動正式帳號）
UPDATE venues
   SET bank_institution_name = NULL,
       bank_branch_name       = NULL,
       account_holder         = NULL,
       account_number         = NULL,
       updated_at             = NOW()
 WHERE id = 'B' AND account_number = '00012345678900';

COMMIT;
