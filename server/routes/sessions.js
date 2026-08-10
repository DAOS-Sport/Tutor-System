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
const COACH_ENROLLMENT_STATUSES = "('pending_payment','confirmed','active')";

router.get('/coach/:coachId/enrollments', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  const { coachId } = req.params;
  try {
    // counts 另外用聚合查，不從 items 數出來：items 有 LIMIT，用它算會在超過上限時
    // 靜靜地少報，而畫面上那個數字看起來一樣可信。
    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT ae.id, ae.status::text AS status, ae.parent_name, ae.students,
                ae.course_type, ae.venue_id, v.name AS venue_name,
                ae.total_sessions, ae.used_sessions,
                ae.submitted_at, ae.created_at, ae.updated_at,
                ae.invoice_issued_at, ae.returned_at
           FROM admin_enrollments ae
           LEFT JOIN admin_venues v ON v.id = ae.venue_id
          WHERE ${COACH_ENROLLMENT_SCOPE}
            AND ae.status::text IN ${COACH_ENROLLMENT_STATUSES}
          ORDER BY COALESCE(ae.submitted_at, ae.created_at) DESC
          LIMIT 200`,
        [coachId]
      ),
      pool.query(
        `SELECT ae.status::text AS status, COUNT(*)::int AS n
           FROM admin_enrollments ae
          WHERE ${COACH_ENROLLMENT_SCOPE}
            AND ae.status::text IN ${COACH_ENROLLMENT_STATUSES}
          GROUP BY 1`,
        [coachId]
      ),
    ]);
    const counts = { pending_payment: 0, confirmed: 0, active: 0 };
    let total = 0;
    for (const row of countRes.rows) {
      if (counts[row.status] !== undefined) counts[row.status] = row.n;
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
        ORDER BY p.end_date
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
