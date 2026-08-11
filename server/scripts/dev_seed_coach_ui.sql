-- =====================================================================
-- 教練端改版：DEV 測試資料 seed
-- =====================================================================
-- 用途：讓教練端每個模組都有東西可看，供 Owner 在 DEV 實測 2026-08-11 的八節改版。
--
-- 執行（DEV only）：
--   cd server && node -e "…" 或 psql "$DATABASE_URL" -f server/scripts/dev_seed_coach_ui.sql
--
-- 安全特性：
--   * **只給 DEV 用。** 開頭有守門：current_database() 必須是 heliumdb，否則整份中止。
--   * 全 idempotent：固定 UUID + ON CONFLICT / WHERE NOT EXISTS，可重複執行。
--   * 所有新建資料的 UUID 皆以 `5eed`（seed）開頭、admin_enrollments.id 皆以
--     `ESEED-` 開頭，方便 dev_cleanup_coach_ui.sql 一鍵清除。
--   * **不掛在 51a20488 / a77f9036 這兩個既有 period 底下** —— demo_seed_prod.sql 會
--     無條件 DELETE 那兩個 period 的所有 course_sessions（並 CASCADE 掉簽到與授課
--     記錄）。掛上去的話，Owner 只要再跑一次舊 seed 就全沒了。
--   * 全程直接寫本機表，不觸發 Ragic 回寫（admin_enrollments 無 trigger、無排程掃它）。
--
-- 沿用既有測試帳號（不新建人）：
--   教練   (測試帳號)教練   228eedbc-93fd-4056-8504-9b9274b588bd
--   教練2  (測試帳號)教練2  7a719ac4-2e14-4ee3-8782-553ff01de43d   ← 只用來當「轉派前教練」
--   家長1  (測試帳號)家長   37cfa1f6…   小孩：測試-學員1、測試-學員2
--   家長2  (測試帳號)家長2  df50e9c7…   小孩：測試-學員A、測試-學員B
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_db          TEXT := current_database();

  -- 既有人員（以名稱反查，不照抄 UUID）
  v_coach       UUID;
  v_coach2      UUID;
  v_p1          UUID;   -- (測試帳號)家長
  v_p2          UUID;   -- (測試帳號)家長2
  v_s1          UUID;   -- 測試-學員1（家長1）
  v_s2          UUID;   -- 測試-學員2（家長1）
  v_sa          UUID;   -- 測試-學員A（家長2）
  v_sb          UUID;   -- 測試-學員B（家長2）
  v_staff_id    VARCHAR(50);

  -- 本種子新建的物件（固定 UUID，才能 idempotent 與一鍵清除）
  v_p_today     UUID := '5eed0001-0000-4000-8000-000000000001';  -- 1對2，今日課程 + 進行中訂單
  v_p_done      UUID := '5eed0002-0000-4000-8000-000000000002';  -- 1對1，已完成訂單
  v_p_group     UUID := '5eed0003-0000-4000-8000-000000000003';  -- 1對4 團報，跨家庭共班
  v_go          UUID := '5eed00a0-0000-4000-8000-0000000000a0';  -- group_order

  v_ss_done     UUID := '5eed1000-0000-4000-8000-000000001000';  -- 昨天，已完成 + 授課記錄
  v_ss_in       UUID := '5eed1001-0000-4000-8000-000000001001';  -- 今天 09:00，已簽到
  v_ss_out      UUID := '5eed1002-0000-4000-8000-000000001002';  -- 今天 14:00，未簽到
  v_ss_moved    UUID := '5eed1003-0000-4000-8000-000000001003';  -- 今天 16:00，轉派來的

  v_rec         UUID := '5eed2000-0000-4000-8000-000000002000';  -- session_record
  v_plan        UUID := '5eed2001-0000-4000-8000-000000002001';  -- lesson_plan

  v_today       DATE;
  v_venue       TEXT := 'B';
BEGIN
  -- ── 守門：只准在 DEV 跑 ────────────────────────────────────────────────
  IF v_db <> 'heliumdb' THEN
    RAISE EXCEPTION '這份 seed 只能在 DEV（heliumdb）執行，目前資料庫是 %。已中止。', v_db;
  END IF;

  v_today := (NOW() AT TIME ZONE 'Asia/Taipei')::date;

  SELECT id INTO v_coach  FROM coaches WHERE name = '(測試帳號)教練'  LIMIT 1;
  SELECT id INTO v_coach2 FROM coaches WHERE name = '(測試帳號)教練2' LIMIT 1;
  SELECT id INTO v_p1     FROM parents WHERE name = '(測試帳號)家長'  LIMIT 1;
  SELECT id INTO v_p2     FROM parents WHERE name = '(測試帳號)家長2' LIMIT 1;
  SELECT id INTO v_s1     FROM students WHERE name = '測試-學員1' LIMIT 1;
  SELECT id INTO v_s2     FROM students WHERE name = '測試-學員2' LIMIT 1;
  SELECT id INTO v_sa     FROM students WHERE name = '測試-學員A' LIMIT 1;
  SELECT id INTO v_sb     FROM students WHERE name = '測試-學員B' LIMIT 1;
  SELECT ragic_employee_id INTO v_staff_id FROM coaches WHERE id = v_coach;

  IF v_coach IS NULL OR v_p1 IS NULL OR v_p2 IS NULL
     OR v_s1 IS NULL OR v_s2 IS NULL OR v_sa IS NULL OR v_sb IS NULL THEN
    RAISE EXCEPTION '缺少既有測試帳號（教練／家長1／家長2／四位學員），請先跑 demo_seed_prod.sql。';
  END IF;

  -- ── 0. 可教場館：兩個館 ────────────────────────────────────────────────
  -- 教練端顯示的 venue_ids 來源是 admin_staff_venues ∪ admin_staff.venue_id；
  -- coach_venues 那一支在教練端 API 是死碼（coachVenueScope.js 的 WHERE s.id IS NULL
  -- 配上 INNER JOIN admin_staff，永遠不成立），所以這裡一定要寫 admin_staff_venues。
  IF v_staff_id IS NOT NULL THEN
    INSERT INTO admin_staff_venues (staff_id, venue_id)
    SELECT v_staff_id, x FROM unnest(ARRAY['B','C']) x
    ON CONFLICT DO NOTHING;
  END IF;

  -- ── 1. 個人頁：退回狀態 + 退回原因 + 介紹圖片 ─────────────────────────
  -- rejected 才看得到「主管退回原因」那個區塊（教練端只在該狀態下顯示）。
  UPDATE coaches
     SET intro_review_status = 'rejected',
         intro_review_note   = '（測試）照片請換成教學中的實際畫面，另外請補上專長項目與可授課年齡層。',
         bio_rich_text       = COALESCE(NULLIF(bio_rich_text, ''),
                                        '（測試）教學十年，專長自由式與蛙式基礎建立，擅長帶零基礎與怕水的孩子。'),
         intro_submitted_at  = COALESCE(intro_submitted_at, NOW() - INTERVAL '2 days'),
         intro_reviewed_at   = NOW() - INTERVAL '1 day'
   WHERE id = v_coach;

  INSERT INTO coach_bio_media (id, coach_id, media_type, storage_url, alt_text, sort_order)
  VALUES
    ('5eed3001-0000-4000-8000-000000003001', v_coach, 'image',
     'https://daos-tutoring-courses.replit.app/brand/check.png', '（測試）教學照片 1', 1),
    ('5eed3002-0000-4000-8000-000000003002', v_coach, 'image',
     'https://daos-tutoring-courses.replit.app/brand/check.png', '（測試）教學照片 2', 2)
  ON CONFLICT (id) DO NOTHING;

  -- ── 2. 三個 course_period ─────────────────────────────────────────────
  -- expires_at 是 NOT NULL DATE；status 是 enum，只有
  -- pending_payment / payment_anomaly / active / completed / refunded。
  INSERT INTO course_periods
    (id, coach_id, venue_id, course_type, period_number, expires_at,
     original_price, final_price, total_sessions, used_sessions, status, checkin_mode)
  VALUES
    (v_p_today, v_coach, v_venue, 2, 1, v_today + 180, 6600, 6600, 6, 2, 'active',    'self'),
    (v_p_done,  v_coach, v_venue, 1, 1, v_today + 180, 9000, 9000, 6, 6, 'completed', 'self'),
    (v_p_group, v_coach, v_venue, 4, 1, v_today + 180, 3000, 3000, 6, 1, 'active',    'self')
  ON CONFLICT (id) DO UPDATE
    SET used_sessions = EXCLUDED.used_sessions,
        status        = EXCLUDED.status;

  -- 團報那個班要掛 group_order，教練端才標得出「團主」
  -- （roster CTE 是 LEFT JOIN group_orders ON go.id = cp.group_order_id）
  INSERT INTO group_orders
    (id, leader_parent_id, venue_id, course_type, join_token, coach_id,
     status, min_students, max_students, note)
  VALUES
    (v_go, v_p1, v_venue, 4, 'seedcoachui-group-4-invite', v_coach,
     'approved', 2, 4, '（測試）跨家庭團報：兩個家庭各兩個小孩')
  ON CONFLICT (id) DO UPDATE
    SET status = 'approved', coach_id = EXCLUDED.coach_id;

  UPDATE course_periods SET group_order_id = v_go WHERE id = v_p_group;

  INSERT INTO group_order_members (group_order_id, parent_id, is_leader, status, student_ids)
  VALUES (v_go, v_p1, TRUE,  'joined', ARRAY[v_s1, v_s2]),
         (v_go, v_p2, FALSE, 'joined', ARRAY[v_sa, v_sb])
  ON CONFLICT (group_order_id, parent_id) DO UPDATE SET is_leader = EXCLUDED.is_leader;

  -- ── 3. 班級名冊 ───────────────────────────────────────────────────────
  -- status 是 enum，只有 active / transferred_out。這張表是「同班共 N 位」與
  -- 「各家長的小孩」唯一的資料來源。
  INSERT INTO course_period_enrollments (course_period_id, student_id, status)
  VALUES
    (v_p_today, v_s1, 'active'),
    (v_p_today, v_s2, 'active'),
    (v_p_done,  v_s1, 'active'),
    -- 跨家庭團報：家長1 兩個小孩 + 家長2 兩個小孩，同一個班
    (v_p_group, v_s1, 'active'),
    (v_p_group, v_s2, 'active'),
    (v_p_group, v_sa, 'active'),
    (v_p_group, v_sb, 'active')
  ON CONFLICT (course_period_id, student_id) DO NOTHING;

  -- ── 4. 今日課程：三堂（已簽到／未簽到／轉派來的）+ 昨天一堂已完成 ──────
  INSERT INTO course_sessions
    (id, course_period_id, coach_id, scheduled_at, duration_minutes, status,
     created_via, reassigned_from_coach_id)
  VALUES
    (v_ss_done,  v_p_today, v_coach,
     ((v_today - 1) + TIME '10:00') AT TIME ZONE 'Asia/Taipei', 60, 'completed',  'booking', NULL),
    (v_ss_in,    v_p_today, v_coach,
     (v_today + TIME '09:00') AT TIME ZONE 'Asia/Taipei', 60, 'confirmed', 'self_checkin', NULL),
    (v_ss_out,   v_p_today, v_coach,
     (v_today + TIME '14:00') AT TIME ZONE 'Asia/Taipei', 60, 'confirmed', 'booking', NULL),
    -- 轉派：cs.coach_id 是現任教練，reassigned_from_coach_id 是原教練，
    -- 卡片上會出現「原授課教練：(測試帳號)教練2」
    (v_ss_moved, v_p_group, v_coach,
     (v_today + TIME '16:00') AT TIME ZONE 'Asia/Taipei', 60, 'confirmed', 'booking', v_coach2)
  ON CONFLICT (id) DO UPDATE
    SET scheduled_at = EXCLUDED.scheduled_at,
        status       = EXCLUDED.status,
        coach_id     = EXCLUDED.coach_id;

  -- 簽到：只有 v_ss_in 與 v_ss_done 有。教練端的「已簽到」判準是
  -- EXISTS(checkin_records)，不看 attendance_status；但家長端有濾 ATTENDED，
  -- 所以兩邊要一致就填 ATTENDED。
  INSERT INTO checkin_records
    (course_session_id, student_id, checked_in_at, checked_in_source,
     attendance_status, checked_in_by_parent_id)
  VALUES
    (v_ss_done, v_s1, ((v_today - 1) + TIME '09:52') AT TIME ZONE 'Asia/Taipei', 'parent', 'ATTENDED', v_p1),
    (v_ss_done, v_s2, ((v_today - 1) + TIME '09:52') AT TIME ZONE 'Asia/Taipei', 'parent', 'ATTENDED', v_p1),
    (v_ss_in,   v_s1, (v_today + TIME '08:47') AT TIME ZONE 'Asia/Taipei', 'parent', 'ATTENDED', v_p1),
    (v_ss_in,   v_s2, (v_today + TIME '08:47') AT TIME ZONE 'Asia/Taipei', 'parent', 'ATTENDED', v_p1)
  ON CONFLICT (course_session_id, student_id) DO NOTHING;

  -- ── 5. 授課記錄與課前規劃 ─────────────────────────────────────────────
  -- status 要是 'submitted' + submitted_at 才算「已填寫」（家長端學習歷程也只吃
  -- submitted）。coach_id 必須等於 COALESCE(cs.coach_id, cp.coach_id)，否則教練
  -- 開這筆會 403。student_records 的 key 是【學員姓名字串】，服務層會用該堂 active
  -- 名單白名單過濾，名字對不上就被丟掉。
  INSERT INTO session_records
    (id, course_session_id, course_period_id, coach_id,
     summary, highlights, improvements, homework, notes,
     status, submitted_at, student_records)
  VALUES
    (v_rec, v_ss_done, v_p_today, v_coach,
     '（測試）今天複習自由式換氣，兩位學員都能連續游 25 公尺。',
     '換氣節奏明顯穩定，不再中途站立。',
     '打水幅度偏大，下次加強腿部放鬆。',
     '在家練習陸上換氣節拍 10 分鐘 × 3 天。',
     '（測試）本筆為 seed 產生的示範記錄。',
     'submitted', NOW() - INTERVAL '20 hours',
     jsonb_build_object(
       'mode', 'individual',
       'records', jsonb_build_object(
         '測試-學員1', jsonb_build_object('summary','（測試）換氣進步明顯','highlights','敢把頭埋進水裡了',
                                          'improvements','手臂入水點偏內','homework','陸上換氣 10 分鐘','notes',''),
         '測試-學員2', jsonb_build_object('summary','（測試）踢腿力量足但節奏亂','highlights','體力好',
                                          'improvements','需要跟上口令節奏','homework','節拍器練習','notes','')
       )
     ))
  ON CONFLICT (course_session_id) DO UPDATE
    SET status = 'submitted', submitted_at = EXCLUDED.submitted_at;

  INSERT INTO lesson_plans
    (id, course_period_id, coach_id, goals, expected_outcomes, learning_plan,
     initial_assessment, notes, status, published_at)
  VALUES
    (v_plan, v_p_today, v_coach,
     '（測試）六堂課內完成自由式換氣與 25 公尺連續游。',
     '結業時可獨立完成 25 公尺自由式。',
     '第 1-2 堂水感與漂浮、第 3-4 堂打水、第 5-6 堂換氣整合。',
     '入班評估：可漂浮，換氣會嗆到。',
     '（測試）本筆為 seed 產生的示範規劃。',
     'published', NOW() - INTERVAL '3 days')
  ON CONFLICT (course_period_id) DO UPDATE
    SET status = 'published', published_at = EXCLUDED.published_at;

  -- ── 6. 報名記錄：四顆篩選鈕都要有東西 ─────────────────────────────────
  -- 「一筆」＝ (COALESCE(enrollment_batch_id::text, id), period_number)。
  -- 分桶：pending_payment → 待對帳；min(used) >= max(total) → 已完成；其餘 → 進行中。
  -- 注意 used 取 min、total 取 max（全員上完才算已完成）。

  -- (a) 進行中：1對2 兩兄妹，同 batch 同期 → 畫面上必須顯示成「1 筆」「2 位」
  INSERT INTO admin_enrollments
    (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
     original_price, final_price, status, submitted_at, total_sessions, used_sessions,
     enrollment_batch_id, period_number, period_count, invoice_issued_at)
  VALUES
    ('ESEED-ONGOING-1', '(測試帳號)家長', '0912345678', ARRAY['測試-學員1'],
     '(測試帳號)教練', v_coach, v_venue, 2, 3300, 3300, 'confirmed',
     NOW() - INTERVAL '10 days', 6, 2,
     '5eedb001-0000-4000-8000-00000000b001', 1, 1, NOW() - INTERVAL '9 days'),
    ('ESEED-ONGOING-2', '(測試帳號)家長', '0912345678', ARRAY['測試-學員2'],
     '(測試帳號)教練', v_coach, v_venue, 2, 3300, 3300, 'confirmed',
     NOW() - INTERVAL '10 days', 6, 2,
     '5eedb001-0000-4000-8000-00000000b001', 1, 1, NOW() - INTERVAL '9 days'),

  -- (b) 已完成：堂數上完（每一列都要 used >= total，因為 used 取 min）
    ('ESEED-DONE-1', '(測試帳號)家長', '0912345678', ARRAY['測試-學員1'],
     '(測試帳號)教練', v_coach, v_venue, 1, 9000, 9000, 'confirmed',
     NOW() - INTERVAL '90 days', 6, 6,
     '5eedb002-0000-4000-8000-00000000b002', 1, 1, NOW() - INTERVAL '89 days'),

  -- (c) 剛報名待對帳：沒有 course_period（實際流程就是對帳後才建），
  --     卡片上會顯示「名單待對帳後確認」
    ('ESEED-PENDING-1', '(測試帳號)家長2', '0922222222', ARRAY['測試-學員A'],
     '(測試帳號)教練', v_coach, v_venue, 1, 9000, 9000, 'pending_payment',
     NOW() - INTERVAL '2 days', NULL, NULL,
     '5eedb003-0000-4000-8000-00000000b003', 1, 1, NULL),

  -- (d) 跨家庭團報：兩個家庭各自 batch（各自結帳），但指向同一個 group_order。
  --     教練端會看到兩張卡，每張都列出同班 4 位與兩位家長、團主標記。
    ('ESEED-GROUP-A1', '(測試帳號)家長', '0912345678', ARRAY['測試-學員1'],
     '(測試帳號)教練', v_coach, v_venue, 4, 3000, 3000, 'confirmed',
     NOW() - INTERVAL '5 days', 6, 1,
     '5eedb004-0000-4000-8000-00000000b004', 1, 1, NOW() - INTERVAL '4 days'),
    ('ESEED-GROUP-A2', '(測試帳號)家長', '0912345678', ARRAY['測試-學員2'],
     '(測試帳號)教練', v_coach, v_venue, 4, 3000, 3000, 'confirmed',
     NOW() - INTERVAL '5 days', 6, 1,
     '5eedb004-0000-4000-8000-00000000b004', 1, 1, NOW() - INTERVAL '4 days'),
    ('ESEED-GROUP-B1', '(測試帳號)家長2', '0922222222', ARRAY['測試-學員A'],
     '(測試帳號)教練', v_coach, v_venue, 4, 3000, 3000, 'confirmed',
     NOW() - INTERVAL '5 days', 6, 1,
     '5eedb005-0000-4000-8000-00000000b005', 1, 1, NOW() - INTERVAL '4 days'),
    ('ESEED-GROUP-B2', '(測試帳號)家長2', '0922222222', ARRAY['測試-學員B'],
     '(測試帳號)教練', v_coach, v_venue, 4, 3000, 3000, 'confirmed',
     NOW() - INTERVAL '5 days', 6, 1,
     '5eedb005-0000-4000-8000-00000000b005', 1, 1, NOW() - INTERVAL '4 days')
  ON CONFLICT (id) DO UPDATE
    SET status              = EXCLUDED.status,
        total_sessions      = EXCLUDED.total_sessions,
        used_sessions       = EXCLUDED.used_sessions,
        enrollment_batch_id = EXCLUDED.enrollment_batch_id,
        period_number       = EXCLUDED.period_number,
        coach_id            = EXCLUDED.coach_id;

  -- 團報四列掛上 group_order_id（教練端的「團報」徽章來自 bool_or(group_order_id IS NOT NULL)）
  UPDATE admin_enrollments SET group_order_id = v_go, is_group_shared = TRUE
   WHERE id IN ('ESEED-GROUP-A1','ESEED-GROUP-A2','ESEED-GROUP-B1','ESEED-GROUP-B2');

  -- 把訂單與班對起來：教練端 periods CTE 的三選一 join 走
  -- (cp.enrollment_batch_id = ae.enrollment_batch_id AND cp.period_number = ae.period_number)
  UPDATE course_periods SET enrollment_batch_id = '5eedb001-0000-4000-8000-00000000b001'
   WHERE id = v_p_today;
  UPDATE course_periods SET enrollment_batch_id = '5eedb002-0000-4000-8000-00000000b002'
   WHERE id = v_p_done;
  -- 團報那個班靠 group_order_id 對回去（兩個家庭的 batch 不同，只有團號共用）

  RAISE NOTICE 'dev_seed_coach_ui 完成：教練=% 今日=%', v_coach, v_today;
END $$;

COMMIT;
