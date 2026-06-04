-- =====================================================================
-- DAOS DEMO 測試資料 seed（正式 DB 用）
-- =====================================================================
-- 用途：在正式部署 DB 建立可重複、可清除的 demo 測試資料，供：
--   (1) 家長報名 → 後台換教練
--   (2) 團購邀請連結加入
--   兩條流程在正式站用 demo 帳號完整測試。
--
-- 安全特性：
--   * 全程「直接 SQL 寫本機表」，不觸發任何 Ragic 回寫。
--   * 全 idempotent（WHERE NOT EXISTS / ON CONFLICT DO NOTHING），可重複執行。
--   * 所有測試資料皆帶 `(測試帳號)` / `測試-` / `(測試)` 標記，方便用
--     demo_cleanup_prod.sql 一鍵清除。
--   * 場館轉帳帳號「只在空白時才填」，不覆蓋正式帳號。
--   * 一律以「手機 / 名稱 / venue」查正式站 id，不照抄任何 DEV UUID。
--
-- 執行：psql "$PROD_DATABASE_URL" -f server/scripts/demo_seed_prod.sql
--       （或貼進正式 DB 的 SQL console 整段執行）
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_venue        TEXT := 'B';
  v_coach1_eid   TEXT := '0605065';
  v_coach2_eid   TEXT := '0605066';
  v_coach1       UUID;
  v_coach2       UUID;
  v_p1           UUID;   -- (測試帳號)家長
  v_p2           UUID;   -- (測試帳號)家長2
  v_s1           UUID;   -- 測試-學員1
  v_s2           UUID;   -- 測試-學員2
  v_sa           UUID;   -- 測試-學員A（家長2）
  v_period_act   UUID;   -- 教練1 active period（換教練 + 轉讓）
  v_period_done  UUID;   -- 教練1 completed period（期末評鑑）
  v_period_c2    UUID;   -- 教練2 active period
  v_sess_today   UUID;
  v_join_token   TEXT := 'demotestgroup3invite0001';
  v_go           UUID;
BEGIN
  ------------------------------------------------------------------
  -- B. demo 帳號底層記錄
  ------------------------------------------------------------------
  -- 家長1（0912345678）
  INSERT INTO parents (phone, name, primary_venue_id)
  SELECT '0912345678', '(測試帳號)家長', v_venue
  WHERE NOT EXISTS (SELECT 1 FROM parents WHERE phone = '0912345678');
  SELECT id INTO v_p1 FROM parents WHERE phone = '0912345678';

  -- 家長2（0922222222）
  INSERT INTO parents (phone, name, primary_venue_id)
  SELECT '0922222222', '(測試帳號)家長2', v_venue
  WHERE NOT EXISTS (SELECT 1 FROM parents WHERE phone = '0922222222');
  SELECT id INTO v_p2 FROM parents WHERE phone = '0922222222';

  -- 學員（家長1：測試-學員1 / 測試-學員2）
  INSERT INTO students (parent_id, name, birth_date)
  SELECT v_p1, '測試-學員1', DATE '2015-03-01'
  WHERE NOT EXISTS (SELECT 1 FROM students WHERE parent_id = v_p1 AND name = '測試-學員1');
  INSERT INTO students (parent_id, name, birth_date)
  SELECT v_p1, '測試-學員2', DATE '2017-06-15'
  WHERE NOT EXISTS (SELECT 1 FROM students WHERE parent_id = v_p1 AND name = '測試-學員2');
  SELECT id INTO v_s1 FROM students WHERE parent_id = v_p1 AND name = '測試-學員1';
  SELECT id INTO v_s2 FROM students WHERE parent_id = v_p1 AND name = '測試-學員2';

  -- 學員（家長2：測試-學員A）
  INSERT INTO students (parent_id, name, birth_date)
  SELECT v_p2, '測試-學員A', DATE '2016-09-09'
  WHERE NOT EXISTS (SELECT 1 FROM students WHERE parent_id = v_p2 AND name = '測試-學員A');
  SELECT id INTO v_sa FROM students WHERE parent_id = v_p2 AND name = '測試-學員A';

  -- 教練1（coaches）
  INSERT INTO coaches (ragic_employee_id, name, phone, pricing_multiplier, is_active)
  SELECT v_coach1_eid, '(測試帳號)教練', '0900000000', 1.00, TRUE
  WHERE NOT EXISTS (SELECT 1 FROM coaches WHERE ragic_employee_id = v_coach1_eid);
  SELECT id INTO v_coach1 FROM coaches WHERE ragic_employee_id = v_coach1_eid;

  -- 教練2（coaches）
  INSERT INTO coaches (ragic_employee_id, name, phone, pricing_multiplier, is_active)
  SELECT v_coach2_eid, '(測試帳號)教練2', '0900000001', 1.00, TRUE
  WHERE NOT EXISTS (SELECT 1 FROM coaches WHERE ragic_employee_id = v_coach2_eid);
  SELECT id INTO v_coach2 FROM coaches WHERE ragic_employee_id = v_coach2_eid;

  -- coach_venues（B）
  INSERT INTO coach_venues (coach_id, venue_id)
  SELECT v_coach1, v_venue
  WHERE NOT EXISTS (SELECT 1 FROM coach_venues WHERE coach_id = v_coach1 AND venue_id = v_venue);
  INSERT INTO coach_venues (coach_id, venue_id)
  SELECT v_coach2, v_venue
  WHERE NOT EXISTS (SELECT 1 FROM coach_venues WHERE coach_id = v_coach2 AND venue_id = v_venue);

  -- admin_staff（id = ragic_employee_id；後台「換教練」下拉 INNER JOIN coaches 需要）
  INSERT INTO admin_staff (id, name, role, venue_id, phone, multiplier, active, ragic_record_id)
  SELECT v_coach1_eid, '(測試帳號)教練', 'coach', v_venue, '0900000000', 1.00, TRUE, v_coach1_eid
  WHERE NOT EXISTS (SELECT 1 FROM admin_staff WHERE id = v_coach1_eid);
  INSERT INTO admin_staff (id, name, role, venue_id, phone, multiplier, active, ragic_record_id)
  SELECT v_coach2_eid, '(測試帳號)教練2', 'coach', v_venue, '0900000001', 1.00, TRUE, v_coach2_eid
  WHERE NOT EXISTS (SELECT 1 FROM admin_staff WHERE id = v_coach2_eid);

  -- admin_staff_venues（員工↔場館中間表）
  INSERT INTO admin_staff_venues (staff_id, venue_id)
  SELECT v_coach1_eid, v_venue
  WHERE NOT EXISTS (SELECT 1 FROM admin_staff_venues WHERE staff_id = v_coach1_eid AND venue_id = v_venue);
  INSERT INTO admin_staff_venues (staff_id, venue_id)
  SELECT v_coach2_eid, v_venue
  WHERE NOT EXISTS (SELECT 1 FROM admin_staff_venues WHERE staff_id = v_coach2_eid AND venue_id = v_venue);

  ------------------------------------------------------------------
  -- C1. 場館 B 轉帳帳號（只在空白時填，不覆蓋正式帳號）
  ------------------------------------------------------------------
  UPDATE venues
     SET bank_institution_name = '(測試)台灣銀行',
         bank_branch_name       = '(測試)示範分行',
         account_holder         = '(測試帳號)夢想體育學院',
         account_number         = '00012345678900',
         updated_at             = NOW()
   WHERE id = v_venue
     AND (account_number IS NULL OR account_number = '');

  ------------------------------------------------------------------
  -- C2/C4. 教練1 active 課程期（換教練示範 + 轉讓示範）
  ------------------------------------------------------------------
  SELECT id INTO v_period_act FROM course_periods
   WHERE coach_id = v_coach1 AND venue_id = v_venue AND course_type = 1 AND status = 'active'
   ORDER BY created_at LIMIT 1;
  IF v_period_act IS NULL THEN
    INSERT INTO course_periods
      (coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at, original_price, final_price, status)
    VALUES (v_coach1, v_venue, 1, 6, 0, (CURRENT_DATE + 365), 9000, 9000, 'active')
    RETURNING id INTO v_period_act;
  END IF;
  -- 家長1 學員1 掛 active period（轉讓下拉要有資料）
  INSERT INTO course_period_enrollments (course_period_id, student_id, status)
  SELECT v_period_act, v_s1, 'active'
  WHERE NOT EXISTS (SELECT 1 FROM course_period_enrollments WHERE course_period_id = v_period_act AND student_id = v_s1);
  -- 未來課程 session（換教練會「重新指派 N 堂未來課程」）
  -- 時間錨定型資料每次重設（先斷 slot↔session 循環參考再刪），確保跨日重跑不漂移、不過期。
  UPDATE coach_availability_slots SET booked_session_id = NULL
   WHERE booked_session_id IN (SELECT id FROM course_sessions WHERE course_period_id = v_period_act);
  DELETE FROM course_sessions WHERE course_period_id = v_period_act;
  INSERT INTO course_sessions (course_period_id, scheduled_at, duration_minutes, status)
  VALUES (v_period_act, NOW() + INTERVAL '3 days', 60, 'confirmed');

  ------------------------------------------------------------------
  -- C3. 教練1 completed 課程期 + 期末評鑑邀請（待填）
  ------------------------------------------------------------------
  SELECT id INTO v_period_done FROM course_periods
   WHERE coach_id = v_coach1 AND venue_id = v_venue AND status = 'completed'
   ORDER BY created_at LIMIT 1;
  IF v_period_done IS NULL THEN
    INSERT INTO course_periods
      (coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at, original_price, final_price, status)
    VALUES (v_coach1, v_venue, 1, 6, 6, (CURRENT_DATE + 30), 9000, 9000, 'completed')
    RETURNING id INTO v_period_done;
  END IF;
  -- 評鑑邀請（submitted_at = NULL 表示待填）
  INSERT INTO course_evaluations (course_period_id, parent_id, coach_id, invited_at, submitted_at)
  SELECT v_period_done, v_p1, v_coach1, NOW(), NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM course_evaluations
     WHERE course_period_id = v_period_done AND parent_id = v_p1 AND submitted_at IS NULL
  );
  -- completed period 掛 enrollment（學習歷程顯示）
  INSERT INTO course_period_enrollments (course_period_id, student_id, status)
  SELECT v_period_done, v_s1, 'active'
  WHERE NOT EXISTS (SELECT 1 FROM course_period_enrollments WHERE course_period_id = v_period_done AND student_id = v_s1);

  ------------------------------------------------------------------
  -- C5. 教練2 教練端不空：period + 今日 session + slots + lesson_plan + enrollment
  ------------------------------------------------------------------
  SELECT id INTO v_period_c2 FROM course_periods
   WHERE coach_id = v_coach2 AND venue_id = v_venue AND status = 'active'
   ORDER BY created_at LIMIT 1;
  IF v_period_c2 IS NULL THEN
    INSERT INTO course_periods
      (coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at, original_price, final_price, status)
    VALUES (v_coach2, v_venue, 1, 6, 0, (CURRENT_DATE + 365), 9000, 9000, 'active')
    RETURNING id INTO v_period_c2;
  END IF;
  -- 今日 confirmed session + slots：時間錨定型資料每次重設並錨定「當天」，
  -- 確保跨日重跑不漂移、且「今日課程」永遠落在實際測試當天（先斷 slot↔session 循環參考）。
  UPDATE course_sessions SET availability_slot_id = NULL WHERE course_period_id = v_period_c2;
  UPDATE coach_availability_slots SET booked_session_id = NULL WHERE coach_id = v_coach2;
  DELETE FROM course_sessions WHERE course_period_id = v_period_c2;
  DELETE FROM coach_availability_slots WHERE coach_id = v_coach2;

  -- 今日 confirmed session（教練端「今日課程」要看得到）
  INSERT INTO course_sessions (course_period_id, scheduled_at, duration_minutes, status)
  VALUES (v_period_c2, date_trunc('day', NOW()) + INTERVAL '18 hours', 60, 'confirmed')
  RETURNING id INTO v_sess_today;

  -- slots：available / blocked / booked
  INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status)
  VALUES (v_coach2, v_venue, date_trunc('day', NOW()) + INTERVAL '1 day' + INTERVAL '10 hours', 60, 'available');
  INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status)
  VALUES (v_coach2, v_venue, date_trunc('day', NOW()) + INTERVAL '1 day' + INTERVAL '11 hours', 60, 'blocked');
  INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status, booked_session_id)
  VALUES (v_coach2, v_venue, date_trunc('day', NOW()) + INTERVAL '18 hours', 60, 'booked', v_sess_today);
  -- lesson_plan（published）
  IF NOT EXISTS (SELECT 1 FROM lesson_plans WHERE course_period_id = v_period_c2 AND coach_id = v_coach2) THEN
    INSERT INTO lesson_plans
      (course_period_id, coach_id, goals, expected_outcomes, learning_plan, initial_assessment, notes, status, published_at)
    VALUES (v_period_c2, v_coach2,
            '(測試)提升基本體能與協調', '(測試)能完成基礎動作組合',
            '(測試)六堂漸進式課表', '(測試)初評：協調性中等', '(測試)備註',
            'published', NOW());
  END IF;
  -- 家長1 學員2 掛 coach2 period
  INSERT INTO course_period_enrollments (course_period_id, student_id, status)
  SELECT v_period_c2, v_s2, 'active'
  WHERE NOT EXISTS (SELECT 1 FROM course_period_enrollments WHERE course_period_id = v_period_c2 AND student_id = v_s2);

  ------------------------------------------------------------------
  -- D. 團購邀請連結（forming，一對三 2/3，家長1 為團主；家長2 不加入、保留名額）
  ------------------------------------------------------------------
  SELECT id INTO v_go FROM group_orders WHERE join_token = v_join_token;
  IF v_go IS NULL THEN
    INSERT INTO group_orders
      (leader_parent_id, venue_id, course_type, coach_id, status, join_token, min_students, max_students, note)
    VALUES (v_p1, v_venue, 3, v_coach1, 'forming', v_join_token, 2, 3, '(測試帳號)團購邀請')
    RETURNING id INTO v_go;
  END IF;
  -- 團主成員（家長1 + 學員1）
  INSERT INTO group_order_members
    (group_order_id, parent_id, student_names, student_ids, is_leader, status)
  SELECT v_go, v_p1, ARRAY['測試-學員1']::text[], ARRAY[v_s1]::uuid[], TRUE, 'joined'
  WHERE NOT EXISTS (SELECT 1 FROM group_order_members WHERE group_order_id = v_go AND parent_id = v_p1);

  RAISE NOTICE 'DEMO seed 完成：parent1=% parent2=% coach1=% coach2=% join_token=%', v_p1, v_p2, v_coach1, v_coach2, v_join_token;
END $$;

COMMIT;
