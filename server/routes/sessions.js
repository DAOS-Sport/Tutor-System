// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔凍結範圍：教練簽到（整班寫入、FOR UPDATE OF cp 鎖序、usageSync 同步）。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
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
const { broadcastAdminEvent } = require('../services/websocket');
const { getFeatureFlag, flagAllowsPhone } = require('../services/featureFlags');
const { addCalendarDays, taipeiWeekStart } = require('../utils/dateTime');
const { syncStoredUsage } = require('../services/usageSync');

function todayWhereTaipei(columnSql = 'cs.scheduled_at') {
  return `(${columnSql} AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date`;
}

// 教練端唯讀：自己學生的報名狀態總覽。
//
// 教練現在只看得到「已經開通的課」，看不到卡在報名流程中的學生——家長說「我報名了」
// 但課還沒出現時，教練無從判斷是家長還沒付款、櫃檯還沒對帳、還是根本沒報。
// 這裡把 admin_enrollments 的狀態依教練範圍攤開，讓他自己看得到。
//
// 只回狀態與姓名，不回金額／付款證明／發票等金流細節——教練不需要，也不該看到。
router.get('/coach/:coachId/enrollments', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  const { coachId } = req.params;
  try {
    const r = await pool.query(
      `SELECT ae.id, ae.status::text AS status, ae.parent_name, ae.students,
              ae.course_type, ae.venue_id, v.name AS venue_name,
              ae.total_sessions, ae.used_sessions,
              ae.submitted_at, ae.created_at
         FROM admin_enrollments ae
         LEFT JOIN admin_venues v ON v.id = ae.venue_id
        WHERE ae.coach_id = $1
          -- 不含 'active'：那批 legacy 資料 coach_id 皆為 NULL，本來就被上面的
          -- coach_id 條件濾掉，列在白名單裡只會讓人以為它會出現。
          AND ae.status::text IN ('pending_payment','confirmed')
        ORDER BY
          -- 卡住的排前面：教練最需要知道的是「誰還沒完成」
          CASE ae.status::text WHEN 'pending_payment' THEN 0 ELSE 1 END,
          COALESCE(ae.submitted_at, ae.created_at) DESC
        LIMIT 60`,
      [coachId]
    );
    const counts = { pending_payment: 0, confirmed: 0 };
    for (const row of r.rows) {
      if (counts[row.status] !== undefined) counts[row.status] += 1;
    }
    res.json({ counts, items: r.rows });
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
         AND ${todayWhereTaipei('cs.scheduled_at')}
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
         AND cs.scheduled_at >= $2 AND cs.scheduled_at < $3
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
         AND (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date < (NOW() AT TIME ZONE 'Asia/Taipei')::date
         AND cs.status IN ('confirmed', 'completed')
         AND ($2::date IS NULL OR (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date >= $2::date)
         AND ($3::date IS NULL OR (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date <= $3::date)
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

router.post('/:id/checkins', requireCoach, async (req, res) => {
  const studentId = String(req.body?.studentId || '').trim();
  if (!studentId) return res.status(400).json({ error: 'studentId required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ctx = await client.query(
      `SELECT cs.id AS session_id, cs.status::text AS session_status,
              cp.id AS period_id, cp.venue_id, cp.course_type,
              cp.admin_enrollment_id, cp.group_order_id, cp.enrollment_batch_id, cp.period_number,
              COALESCE(cs.coach_id, cp.coach_id) AS coach_id,
              c.name AS coach_name, v.name AS venue_name
         FROM course_sessions cs
         JOIN course_periods cp ON cp.id = cs.course_period_id
         LEFT JOIN coaches c ON c.id = COALESCE(cs.coach_id, cp.coach_id)
         LEFT JOIN venues v ON v.id = cp.venue_id
        WHERE cs.id = $1
        FOR UPDATE OF cp`,
      [req.params.id]
    );
    // FOR UPDATE OF cp：與手動扣課／家長簽到共用 period 列鎖，序列化
    // 「計數已出席堂數 → 寫回 used_sessions 鏡射」，避免並發舊值覆寫。
    if (!ctx.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'session not found' });
    }
    const session = ctx.rows[0];
    if (String(session.coach_id) !== String(req.coach.id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!['confirmed', 'completed'].includes(session.session_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: session.session_status === 'pending_group_confirm'
          ? '此課程仍在等待同組家長確認，暫不可簽到'
          : '此課程狀態不可簽到',
        code: 'SESSION_NOT_CHECKINABLE',
      });
    }

    const stu = await client.query(
      `SELECT s.id, s.name, p.id AS parent_id, p.name AS parent_name
         FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
         JOIN parents p ON p.id = s.parent_id
        WHERE cpe.course_period_id = $1
          AND cpe.status = 'active'
          AND s.id = $2`,
      [session.period_id, studentId]
    );
    if (!stu.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '該學員未在此課程名單中' });
    }

    const roster = await client.query(
      `SELECT s.id, p.phone
         FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
         JOIN parents p ON p.id = s.parent_id
        WHERE cpe.course_period_id = $1 AND cpe.status = 'active'
          AND COALESCE(s.is_active, TRUE) = TRUE`,
      [session.period_id]
    );
    const sharedFlag = await getFeatureFlag('SHARED_CHECKIN_USAGE_V2', client);
    const sharedV2 = roster.rows.some((row) => flagAllowsPhone(sharedFlag, row.phone));
    if (sharedV2) {
      await client.query(
        `INSERT INTO checkin_records
           (course_session_id, student_id, checked_in_by_student_id,
            checked_in_source, checked_in_by_coach_id)
         SELECT $1, cpe.student_id, cpe.student_id, 'coach', $2
           FROM course_period_enrollments cpe
           JOIN students s ON s.id = cpe.student_id
          WHERE cpe.course_period_id = $3 AND cpe.status = 'active'
            AND COALESCE(s.is_active, TRUE) = TRUE
         ON CONFLICT (course_session_id, student_id) DO NOTHING`,
        [req.params.id, req.coach.id, session.period_id]
      );
    } else {
      await client.query(
        `INSERT INTO checkin_records
           (course_session_id, student_id, checked_in_by_student_id,
            checked_in_source, checked_in_by_coach_id)
         VALUES ($1, $2, $2, 'coach', $3)
         ON CONFLICT (course_session_id, student_id) DO NOTHING`,
        [req.params.id, studentId, req.coach.id]
      );
    }
    const ins = await client.query(
      `SELECT id, checked_in_at, checked_in_source
         FROM checkin_records WHERE course_session_id = $1 AND student_id = $2`,
      [req.params.id, studentId]
    );
    const usedRes = await client.query(
      `SELECT COUNT(DISTINCT cs.id)::int AS n
         FROM course_sessions cs JOIN checkin_records cr ON cr.course_session_id = cs.id
        WHERE cs.course_period_id = $1 AND cs.status::text NOT LIKE 'cancelled%'
          AND cr.attendance_status = 'ATTENDED'`,
      [session.period_id]
    );
    await client.query(
      `UPDATE course_sessions SET session_deducted = TRUE, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    await syncStoredUsage(client, session, Number(usedRes.rows[0]?.n || 0));
    await client.query('COMMIT');

    const row = ins.rows[0];
    const s = stu.rows[0];
    try {
      broadcastAdminEvent('checkin:created', {
        checkin_id: row.id,
        at: row.checked_in_at instanceof Date ? row.checked_in_at.toISOString() : String(row.checked_in_at),
        session_id: req.params.id,
        period_id: session.period_id,
        venue_id: session.venue_id,
        venue_name: session.venue_name || session.venue_id,
        course_type: Number(session.course_type) || null,
        coach: session.coach_name || '',
        student: s.name || '',
        source: row.checked_in_source || 'coach',
      });
    } catch (e) { console.warn('[sessions checkins] broadcast skipped:', e?.message); }

    res.json({
      ok: true,
      checkin_id: row.id,
      checked_in_at: row.checked_in_at,
      source: row.checked_in_source || 'coach',
      student: { id: s.id, name: s.name, parent_id: s.parent_id, parent_name: s.parent_name },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[sessions checkins]', err);
    res.status(500).json({ error: 'checkin failed' });
  } finally {
    client.release();
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
