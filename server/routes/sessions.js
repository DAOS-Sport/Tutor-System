// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔凍結範圍：教練簽到已於 2026-08-10 依 Owner 指示「完整移除」。
//   原 POST /:id/checkins（教練代簽 / 整班寫入 / 扣堂）已整支刪除，本檔現為全唯讀。
//   ⚠️ 不得以任何形式復活。教練端不應存在任何會寫入 checkin_records、
//      設定 session_deducted、或呼叫 syncStoredUsage 的端點。
//      要新增任何教練端寫入路徑前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
/**
 * course_sessions（已排定課程時段）API
 * - GET /api/sessions/coach/:coachId/today      教練今日已 confirmed 課程一覽
 * - GET /api/sessions/coach/:coachId/week       教練本週已 confirmed 課程
 * - GET /api/sessions/:id                       單筆細節（學員 + 期 + 簽到狀態）
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { requireCoach, requireCoachOwner } = require('../middlewares/coachAuth');
const { addCalendarDays, taipeiWeekStart } = require('../utils/dateTime');
const { todayWhere, historyRangeWhere, weekRangeWhere } = require('../utils/sessionDateSql');
// 與家長首頁共用同一份優惠排序：這張卡是教練用來回答家長「現在有什麼活動」的，
// 兩邊看到的順序不一致，教練念的第一檔跟家長看到的第一檔就會對不上。
const { promoDisplayOrderSql } = require('../services/promotions');


// 教練端唯讀：自己學生的報名狀態總覽。
//
// 教練現在只看得到「已經開通的課」，看不到卡在報名流程中的學生——家長說「我報名了」
// 但課還沒出現時，教練無從判斷是家長還沒付款、櫃檯還沒對帳、還是根本沒報。
// 這裡把 admin_enrollments 的狀態依教練範圍攤開，讓他自己看得到。
//
// 回傳狀態、姓名與各階段時間戳；不回金額／付款證明／發票號碼——教練不需要，也不該看到。
// invoice_issued_at 是「何時對帳完成」的時間點，不是金流細節，故納入。

// 教練可見範圍。coach_id 是主要條件，但櫃檯手建的單可能只填了教練姓名而沒帶
// coach_id（admin/enrollments.js 的 ensureSoloCoursePeriod 就為此做過反查容錯），
// 那些單教練原本永遠看不到。這裡補上姓名回退，但**只在該姓名全平台唯一時才生效**——
// 同名教練互相看到對方的訂單，比看不到更糟。
const COACH_ENROLLMENT_SCOPE = `(
          ae.coach_id = $1::uuid
          OR (
            ae.coach_id IS NULL
            AND btrim(COALESCE(ae.coach, '')) <> ''
            AND btrim(ae.coach) = (
              SELECT btrim(c.name) FROM coaches c
               WHERE c.id = $1::uuid
                 AND (SELECT COUNT(*) FROM coaches c2 WHERE btrim(c2.name) = btrim(c.name)) = 1
            )
          )
        )`;
// 不含 'active'：正式庫那批 legacy 資料是 2026-05-03 同一秒的匯入批次，
// 列在教練可見清單裡只會讓人以為它會出現。本分支新增的「教練姓名回退」
// 反而讓這些 coach_id 為 NULL 的舊列更可能浮出來，所以更該擋掉。
const COACH_ENROLLMENT_STATUSES = "('pending_payment','confirmed')";

/**
 * 「一筆」＝一張訂單＝`(enrollment_batch_id, period_number)`，不是一列資料。
 *
 * ── 為什麼不能直接數資料列 ──
 * admin_enrollments 的粒度是「學員 × 期」。一筆 1對2、一期、兩個小孩的訂單，
 * 在資料庫裡是兩列（同 batch、同 checkout、同期），數列會報成「2 筆」。
 * 2026-08-11 Owner 就是從報名成功信抓到這件事的（發票 DL02996195）。正式庫實測：
 * 508 列 confirmed 其實只有 318 筆訂單，152 筆由多列組成、單筆最多 4 列。
 *
 * ── 為什麼不能只用 enrollment_batch_id ──
 * 250 個 batch 裡有 45 個橫跨多期。只用 batch 會把第 1 期和第 2 期併成一筆，
 * 而那正好毀掉一個真實情境：學生第 5、6 堂時報名下一期，那當下他應該同時出現在
 * 「進行中」（第一期還剩一堂）與「剛報名待對帳」（第二期）。加上 period_number 才對。
 *
 * batch_key 用 COALESCE(...::text, id)：confirmed 上 enrollment_batch_id 實測從不為
 * NULL，但這支也吃 pending_payment，退回自己的 id 等於「自成一筆」，不會整列消失。
 */
const COACH_ORDER_CTE = `
  WITH scoped AS (
    SELECT ae.id, ae.status::text AS status, ae.parent_name, ae.students,
           ae.course_type, ae.venue_id, ae.total_sessions, ae.used_sessions,
           ae.submitted_at, ae.created_at, ae.invoice_issued_at, ae.returned_at,
           ae.period_number, ae.period_count, ae.group_order_id,
           -- 原始 batch id 也要留著：下面的 periods CTE 要拿它跟 course_periods
           -- 比對（batch_key 是 text，course_periods.enrollment_batch_id 是 uuid）。
           ae.enrollment_batch_id,
           COALESCE(ae.enrollment_batch_id::text, ae.id) AS batch_key
      FROM admin_enrollments ae
     WHERE ${COACH_ENROLLMENT_SCOPE}
       AND ae.status::text IN ${COACH_ENROLLMENT_STATUSES}
  ),
  agg AS (
    SELECT s.batch_key, s.period_number,
           min(s.id)                                    AS id,
           -- 同一筆訂單的各列 status 實測 0 筆不一致。真的出現時取字典序大的
           -- （pending_payment > confirmed），偏向「還沒好」——寧可教練多看一眼，
           -- 也不要把還沒對帳的那半當成已確認。
           max(s.status)                                AS status,
           min(s.course_type)                           AS course_type,
           min(s.venue_id)                              AS venue_id,
           -- 堂數在同筆內對不上的有 5 筆（usageSync 的鏡射缺口）。取 min(used) 與
           -- max(total)＝「全員都上完才算已完成」。把還在上的課誤標成已完成，
           -- 會讓教練以為不用再排課；反過來只是多顯示一列，無害得多。
           -- max(total_sessions) 會略過 NULL：一列 6 一列 NULL 時該班就是 6 堂，
           -- NULL 是資料缺口不是「無上限」。全為 NULL 才落到下面的 COALESCE。
           min(COALESCE(s.used_sessions, 0))            AS used_sessions,
           max(s.total_sessions)                        AS total_sessions,
           min(s.period_count)                          AS period_count,
           bool_or(s.group_order_id IS NOT NULL)        AS is_group,
           count(*)::int                                AS row_count,
           min(COALESCE(s.submitted_at, s.created_at))  AS submitted_at,
           max(s.returned_at)                           AS returned_at,
           max(s.invoice_issued_at)                     AS invoice_issued_at
      FROM scoped s
     GROUP BY 1, 2
  ),
  bucketed AS (
    SELECT a.*,
           CASE WHEN a.status = 'pending_payment' THEN 'pending_payment'
                WHEN a.used_sessions >= COALESCE(a.total_sessions, 999) THEN 'completed'
                ELSE 'in_progress' END AS bucket
      FROM agg a
  )`;

router.get('/coach/:coachId/enrollments', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  const { coachId } = req.params;
  try {
    // counts 另外用聚合查，不從 items 數出來：items 有 LIMIT，用它算會在超過上限時
    // 靜靜地少報，而畫面上那個數字看起來一樣可信。
    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `${COACH_ORDER_CTE},
         names AS (
           SELECT s.batch_key, s.period_number,
                  array_agg(DISTINCT btrim(st)) AS students
             FROM scoped s, unnest(s.students) AS st
            WHERE btrim(st) <> ''
            GROUP BY 1, 2
         ),
         payers AS (
           SELECT s.batch_key, s.period_number,
                  array_agg(DISTINCT btrim(s.parent_name)) AS parent_names
             FROM scoped s
            WHERE btrim(COALESCE(s.parent_name, '')) <> ''
            GROUP BY 1, 2
         ),
         -- ── 班級名冊 ──
         -- 訂單是收款單位，班（course_period）是上課單位，兩者不一樣。團報時
         -- 每個家庭各自結帳 → 各自一筆訂單、各自一張發票（正式庫 8 個跨家庭團報
         -- 全部如此），但共用同一個班。教練要看到整班有誰、各掛在哪位家長底下。
         --
         -- join key 三選一，不能只用 admin_enrollment_id：實測 359 筆訂單有 311 筆
         -- 對得到班，只用直連會漏掉團報那一整類。三個條件與 usageSync.js 同一組。
         periods AS (
           SELECT DISTINCT s.batch_key, s.period_number, cp.id AS cp_id,
                  cp.group_order_id AS cp_group
             FROM scoped s
             JOIN course_periods cp
               ON cp.admin_enrollment_id = s.id
               OR (cp.enrollment_batch_id = s.enrollment_batch_id AND cp.period_number = s.period_number)
               OR (cp.group_order_id     = s.group_order_id      AND cp.period_number = s.period_number)
         ),
         -- 每位學生掛在自己的家長底下（students.parent_id 是 NOT NULL，實測 710/710
         -- 都 join 得到）。這就是 Owner 說的「寄託的家長」。用訂單上的付款人的話，
         -- 別的家庭的小孩會被掛到不相干的人底下。
         roster AS (
           SELECT DISTINCT p.batch_key, p.period_number,
                  st.name AS student_name, par.id AS parent_id, par.name AS parent_name,
                  COALESCE(go.leader_parent_id = par.id, FALSE) AS is_leader
             FROM periods p
             JOIN course_period_enrollments cpe
               ON cpe.course_period_id = p.cp_id AND cpe.status = 'active'
             JOIN students st  ON st.id  = cpe.student_id
             JOIN parents  par ON par.id = st.parent_id
             LEFT JOIN group_orders go ON go.id = p.cp_group
         ),
         fam AS (
           SELECT batch_key, period_number, parent_id, parent_name,
                  bool_or(is_leader) AS is_leader,
                  array_agg(DISTINCT student_name) AS students
             FROM roster GROUP BY 1, 2, 3, 4
         ),
         classes AS (
           -- 每位學生只屬於一位家長，所以各家庭人數相加＝全班人數，不會重複計數。
           SELECT batch_key, period_number,
                  SUM(cardinality(students))::int AS class_size,
                  json_agg(json_build_object(
                    'parent_name', parent_name,
                    'is_leader',   is_leader,
                    'students',    students
                  ) ORDER BY is_leader DESC, parent_name) AS families
             FROM fam GROUP BY 1, 2
         )
         SELECT b.id, b.status, b.bucket, b.course_type, b.venue_id, v.name AS venue_name,
                b.total_sessions, b.used_sessions, b.period_number, b.period_count,
                b.is_group, b.row_count,
                b.submitted_at, b.returned_at, b.invoice_issued_at,
                COALESCE(n.students, '{}')     AS students,
                COALESCE(p.parent_names, '{}') AS parent_names,
                c.class_size, c.families
           FROM bucketed b
           LEFT JOIN admin_venues v ON v.id = b.venue_id
           LEFT JOIN names   n ON n.batch_key = b.batch_key AND n.period_number = b.period_number
           LEFT JOIN payers  p ON p.batch_key = b.batch_key AND p.period_number = b.period_number
           LEFT JOIN classes c ON c.batch_key = b.batch_key AND c.period_number = b.period_number
          ORDER BY b.submitted_at DESC
          LIMIT 200`,
        [coachId]
      ),
      pool.query(
        `${COACH_ORDER_CTE}
         SELECT bucket, COUNT(*)::int AS n FROM bucketed GROUP BY 1`,
        [coachId]
      ),
    ]);
    // 四顆篩選鈕的來源。三個桶都先給 0 —— 少掉某個 key 會讓前端把它算成 undefined，
    // 「全部」的加總就對不起來，而那個數字看起來一樣可信。
    const counts = { in_progress: 0, completed: 0, pending_payment: 0 };
    let total = 0;
    for (const row of countRes.rows) {
      if (counts[row.bucket] !== undefined) counts[row.bucket] = row.n;
      total += row.n;
    }
    res.json({ counts, total, items: rowsRes.rows });
  } catch (err) {
    console.error('[sessions coach enrollments]', err.message);
    res.status(500).json({ error: '報名狀態載入失敗' });
  }
});

// 教練端唯讀：目前進行中、且會套用到這位教練的優惠活動。
//
// 判定條件與家長端的套用邏輯一致：
//   狀態 active、當下在起訖區間內
//   applicable_coach_multipliers 為 NULL（不限教練加成）或含這位教練的 pricing_multiplier
//   applicable_venue_ids 為 NULL（全場館）或與這位教練的所屬場館有交集
// 不做 course_type 過濾——教練可能帶多種組別，列出來讓他自己判斷。
router.get('/coach/:coachId/promotions', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  const { coachId } = req.params;
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.description, p.type, p.discount_value,
              p.applicable_course_types, p.applicable_venue_ids,
              -- DATE 轉字串：直接回 Date 物件會在 JSON 序列化時退回前一天。
              p.coupon_code, p.start_date::text AS start_date, p.end_date::text AS end_date
         FROM promotions p
        WHERE p.status = 'active'
          AND NOW() BETWEEN p.start_date AND p.end_date
          -- 與家長端 routes/promotions.js:36 採同一套露出過濾：
          --   show_on_parent_home＝後台的「顯示」開關（純顯示用，不影響折扣是否套用）
          --   有 coupon_code 的要輸入折扣碼，不該被當成「進行中活動」廣播出去
          -- 教練會拿這張卡回答家長「現在有什麼活動」，兩邊看到的必須一致。
          AND p.show_on_parent_home IS NOT FALSE
          AND (p.coupon_code IS NULL OR p.coupon_code = '')
          AND (
            p.applicable_coach_multipliers IS NULL
            OR EXISTS (
              SELECT 1 FROM coaches c
               WHERE c.id = $1
                 AND c.pricing_multiplier = ANY(p.applicable_coach_multipliers)
            )
          )
          AND (
            p.applicable_venue_ids IS NULL
            OR EXISTS (
              SELECT 1 FROM coach_venues cv
               WHERE cv.coach_id = $1 AND cv.venue_id = ANY(p.applicable_venue_ids)
            )
          )
        ${promoDisplayOrderSql('p')}
        LIMIT 20`,
      [coachId]
    );
    res.json({ promotions: r.rows });
  } catch (err) {
    console.error('[sessions coach promotions]', err.message);
    res.status(500).json({ error: '優惠活動載入失敗' });
  }
});

router.get('/coach/:coachId/today', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cs.id, cs.scheduled_at, cs.duration_minutes, cs.status,
              cp.id AS course_period_id, cp.course_type,
              v.id AS venue_id, v.name AS venue_name,
              rc.name AS original_coach_name,
              COALESCE(
                (SELECT json_agg(s.name ORDER BY s.name)
                 FROM course_period_enrollments cpe
                 JOIN students s ON s.id = cpe.student_id
                 WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'),
                '[]'::json
              ) AS student_names,
              EXISTS(SELECT 1 FROM checkin_records WHERE course_session_id = cs.id) AS checked_in,
              -- 教練列表要顯示簽到時分。與上面的 checked_in 採同一判準（不濾 attendance_status），
              -- 否則會出現「已簽到但沒有時間」這種對不起來的畫面。
              (SELECT MIN(cr.checked_in_at) FROM checkin_records cr
                WHERE cr.course_session_id = cs.id) AS checked_in_at
       FROM course_sessions cs
       JOIN course_periods cp ON cs.course_period_id = cp.id
       JOIN venues v ON v.id = cp.venue_id
       LEFT JOIN coaches rc ON rc.id = cs.reassigned_from_coach_id
       WHERE COALESCE(cs.coach_id, cp.coach_id) = $1
         AND ${todayWhere('cs.scheduled_at')}
         AND cs.status IN ('confirmed', 'completed')
       ORDER BY cs.scheduled_at`,
      [req.params.coachId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[sessions] today failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/coach/:coachId/week', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  const { from, to } = req.query;
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : taipeiWeekStart();
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : addCalendarDays(fromDate, 7);
  const fromD = new Date(`${fromDate}T00:00:00+08:00`);
  const toD = new Date(`${toDate}T00:00:00+08:00`);
  try {
    const r = await pool.query(
      `SELECT cs.id, cs.scheduled_at, cs.duration_minutes, cs.status,
              cp.id AS course_period_id, cp.course_type, cp.venue_id,
              rc.name AS original_coach_name,
              COALESCE(
                (SELECT json_agg(s.name ORDER BY s.name)
                 FROM course_period_enrollments cpe
                 JOIN students s ON s.id = cpe.student_id
                 WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'),
                '[]'::json
              ) AS student_names
       FROM course_sessions cs
       JOIN course_periods cp ON cs.course_period_id = cp.id
       LEFT JOIN coaches rc ON rc.id = cs.reassigned_from_coach_id
       WHERE COALESCE(cs.coach_id, cp.coach_id) = $1
         AND ${weekRangeWhere('cs.scheduled_at', '$2', '$3')}
         AND cs.status IN ('confirmed', 'completed', 'pending_group_confirm')
       ORDER BY cs.scheduled_at`,
      [req.params.coachId, fromD.toISOString(), toD.toISOString()]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[sessions] week failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 教練授課記錄：過去（台北時區今天之前）已排定的場次一覽。
 * query：from / to（YYYY-MM-DD，可空）、status（all|checked|unchecked）、periodId（可空）
 * 「已簽到」＝該 session 至少一人簽到（沿用 today handler 的 EXISTS 定義）。
 */
router.get('/coach/:coachId/history', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const status = ['all', 'checked', 'unchecked'].includes(req.query.status) ? req.query.status : 'all';
  const periodId = req.query.periodId || null;
  try {
    const r = await pool.query(
      `SELECT cs.id, cs.scheduled_at, cs.duration_minutes, cs.status,
              cp.id AS course_period_id, cp.course_type,
              v.id AS venue_id, v.name AS venue_name,
              rc.name AS original_coach_name,
              COALESCE(
                (SELECT json_agg(s.name ORDER BY s.name)
                 FROM course_period_enrollments cpe
                 JOIN students s ON s.id = cpe.student_id
                 WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'),
                '[]'::json
              ) AS student_names,
              EXISTS(SELECT 1 FROM checkin_records WHERE course_session_id = cs.id) AS checked_in,
              -- 教練列表要顯示簽到時分。與上面的 checked_in 採同一判準（不濾 attendance_status），
              -- 否則會出現「已簽到但沒有時間」這種對不起來的畫面。
              (SELECT MIN(cr.checked_in_at) FROM checkin_records cr
                WHERE cr.course_session_id = cs.id) AS checked_in_at
       FROM course_sessions cs
       JOIN course_periods cp ON cs.course_period_id = cp.id
       JOIN venues v ON v.id = cp.venue_id
       LEFT JOIN coaches rc ON rc.id = cs.reassigned_from_coach_id
       WHERE COALESCE(cs.coach_id, cp.coach_id) = $1
         AND ${historyRangeWhere('cs.scheduled_at', '$2', '$3')}
         AND cs.status IN ('confirmed', 'completed')
         AND ($4::uuid IS NULL OR cp.id = $4::uuid)
         AND ($5 = 'all'
              OR ($5 = 'checked'   AND     EXISTS(SELECT 1 FROM checkin_records WHERE course_session_id = cs.id))
              OR ($5 = 'unchecked' AND NOT EXISTS(SELECT 1 FROM checkin_records WHERE course_session_id = cs.id)))
       ORDER BY cs.scheduled_at DESC`,
      [req.params.coachId, from, to, periodId, status]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[sessions] history failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 教練授課記錄的「學員篩選」下拉：教練名下每一期課程一列。
 * 每列含學員名單、總堂數、已用堂數（以簽到紀錄計，團體課用 DISTINCT session）、
 * 以及 group_key（團報用 group_order_id；單人報名 fallback 用 active 學員 id 集合）
 * 讓同一組學生跨期相鄰排序。
 */
router.get('/coach/:coachId/history/periods', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cp.id, cp.course_type, cp.total_sessions, cp.period_number, cp.group_order_id,
              COALESCE(
                (SELECT json_agg(s.name ORDER BY s.name)
                 FROM course_period_enrollments cpe
                 JOIN students s ON s.id = cpe.student_id
                 WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'),
                '[]'::json
              ) AS student_names,
              COALESCE(
                (SELECT COUNT(DISTINCT cr.course_session_id)
                 FROM checkin_records cr
                 JOIN course_sessions cs2 ON cs2.id = cr.course_session_id
                 WHERE cs2.course_period_id = cp.id
                   AND cs2.status::text NOT LIKE 'cancelled%'
                   AND cr.attendance_status = 'ATTENDED'),
                0
              )::int AS used_sessions,
              COALESCE(
                cp.group_order_id::text,
                (SELECT string_agg(cpe.student_id::text, ',' ORDER BY cpe.student_id)
                 FROM course_period_enrollments cpe
                 WHERE cpe.course_period_id = cp.id AND cpe.status = 'active')
              ) AS group_key
       FROM course_periods cp
       WHERE cp.coach_id = $1
       ORDER BY group_key NULLS LAST, cp.period_number, cp.created_at`,
      [req.params.coachId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[sessions] history periods failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireCoach, async (req, res) => {
  try {
    // 同時驗證所屬教練 — 若不是本人課程一律 403
    const own = await pool.query(
      `SELECT 1 FROM course_sessions cs JOIN course_periods cp ON cs.course_period_id = cp.id
       WHERE cs.id = $1 AND COALESCE(cs.coach_id, cp.coach_id) = $2`,
      [req.params.id, req.coach.id]
    );
    if (own.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
    const r = await pool.query(
      `SELECT cs.*, cp.course_type, cp.venue_id, v.name AS venue_name,
              rc.name AS original_coach_name,
              COALESCE(
                (SELECT json_agg(s.name ORDER BY s.name)
                 FROM course_period_enrollments cpe
                 JOIN students s ON s.id = cpe.student_id
                 WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'),
                '[]'::json
              ) AS student_names,
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'id', s.id,
                          'name', s.name,
                          'parent_id', p.id,
                          'parent_name', p.name,
                          'checked_in', cr.id IS NOT NULL,
                          'checkin_id', cr.id,
                          'checked_in_at', cr.checked_in_at,
                          'checked_in_source', cr.checked_in_source
                        ) ORDER BY s.name)
                   FROM course_period_enrollments cpe
                   JOIN students s ON s.id = cpe.student_id
                   JOIN parents p ON p.id = s.parent_id
                   LEFT JOIN checkin_records cr
                     ON cr.course_session_id = cs.id
                    AND cr.student_id = s.id
                    AND cr.attendance_status = 'ATTENDED'
                  WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'),
                '[]'::json
              ) AS students_detail
       FROM course_sessions cs
       JOIN course_periods cp ON cs.course_period_id = cp.id
       JOIN venues v ON v.id = cp.venue_id
       LEFT JOIN coaches rc ON rc.id = cs.reassigned_from_coach_id
       WHERE cs.id = $1`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'session not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
