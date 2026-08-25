/**
 * 整合 API（U16）— 給場館現場的外部前端查「這個場館現在有哪些課」。
 *
 * 掛載於 /api/integrations，認證走 middlewares/integrationAuth（服務金鑰 + 場館綁定）。
 *
 *   GET /api/integrations/sessions?venue_id=L&window=90
 *   GET /api/integrations/sessions?venue_id=L&date=2026-08-25
 *
 * ── 使用情境 ──
 * 救生員在池邊看到有教練帶人下水，要當場確認「系統裡有沒有這堂課」。回傳的東西
 * 就是為了讓他在 10 秒內對得起來：教練是誰、幾個人、是不是試上、簽到了沒。
 *
 * ── 這支刻意「查得很窄」──
 * 必須指定場館、時間窗有上限、只讀、欄位白名單從 SQL 就開始。
 * 白名單從 SQL 開始是關鍵：沒有 SELECT 出來的欄位，就不可能因為哪天多寫一行
 * res.json(row) 而外洩。對照組是 tests/public_api_exposure_test.js 記的那次
 * ——欄位白名單做在 JS 層，結果「可以整包枚舉」這件事沒被擋住。
 *
 * ── 明確不回傳 ──
 * 學員全名（一律遮成「林同學」）、家長姓名、任何電話、扣課原因與操作者、
 * checkin_details（裡面有家長全名）。救生台不需要這些，給了只是擴大暴露面。
 */
const express = require('express');
const { pool } = require('../models/db');
const { requireIntegrationKey, logAccess } = require('../middlewares/integrationAuth');
const { maskStudentName } = require('../utils/piiMask');

const router = express.Router();

const DEFAULT_WINDOW_MIN = 90;
const MAX_WINDOW_MIN = 480;     // 8 小時，一個班表的長度；再長就不是「現在」了
const MAX_DATE_OFFSET_DAYS = 7; // 現場工具只需要看最近幾天，不開放翻歷史

/**
 * 欄位白名單 SQL。
 *
 * UNION 舊表 admin_today_sessions 是刻意的：正式庫目前 0 筆、也沒有任何真實流程
 * 回寫，但後台 F-R01 有 UNION 它。這支若少收，畫面上有的課在救生台會查不到，
 * 結果是把合法課程判成「待查」去質疑教練 —— 這種偽陽性的代價比多寫六行高得多。
 */
const SESSIONS_SQL = `
  SELECT * FROM (
    SELECT cs.id::text AS id,
           ((cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date)::text AS date,
           to_char(cs.scheduled_at AT TIME ZONE 'Asia/Taipei', 'HH24:MI') AS start_time,
           to_char((cs.scheduled_at AT TIME ZONE 'Asia/Taipei')
                   + make_interval(mins => COALESCE(cs.duration_minutes, 60)), 'HH24:MI') AS end_time,
           cs.scheduled_at AS sort_at,
           cp.venue_id,
           COALESCE(c.name, '') AS coach,
           cp.course_type,
           COALESCE(cp.is_experience_course, FALSE) AS is_experience_course,
           COALESCE((SELECT json_agg(s.name ORDER BY s.name)
                       FROM course_period_enrollments cpe
                       JOIN students s ON s.id = cpe.student_id
                      WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'), '[]'::json) AS student_names,
           CASE WHEN EXISTS (SELECT 1 FROM checkin_records cr
                              WHERE cr.course_session_id = cs.id AND cr.attendance_status = 'ATTENDED')
                THEN 'checked_in' ELSE 'not_yet' END AS checkin_status,
           (SELECT MIN(cr.checked_in_at) FROM checkin_records cr
             WHERE cr.course_session_id = cs.id AND cr.attendance_status = 'ATTENDED') AS checkin_at
      FROM course_sessions cs
      JOIN course_periods cp ON cp.id = cs.course_period_id
      LEFT JOIN coaches c ON c.id = COALESCE(cs.coach_id, cp.coach_id)
     WHERE cp.venue_id = $1
       AND cs.status::text NOT LIKE 'cancelled%'
       AND cs.scheduled_at >= $2 AND cs.scheduled_at < $3
    UNION ALL
    SELECT ats.id::text AS id,
           ats.date::text AS date,
           ats.start_time::text AS start_time,
           ats.end_time::text AS end_time,
           (ats.date::text || ' ' || ats.start_time::text)::timestamp
             AT TIME ZONE 'Asia/Taipei' AS sort_at,
           ats.venue_id,
           COALESCE(ats.coach, '') AS coach,
           ats.course_type,
           FALSE AS is_experience_course,
           to_json(ats.students) AS student_names,
           ats.checkin_status::text AS checkin_status,
           ats.checkin_at
      FROM admin_today_sessions ats
     WHERE ats.venue_id = $1
       AND (ats.date::text || ' ' || ats.start_time::text)::timestamp
             AT TIME ZONE 'Asia/Taipei' >= $2
       AND (ats.date::text || ' ' || ats.start_time::text)::timestamp
             AT TIME ZONE 'Asia/Taipei' < $3
  ) t
   ORDER BY t.sort_at, t.start_time`;

// 回傳前的最後一道：只組白名單裡的鍵，且學員姓名一律遮罩。
function shapeSession(r) {
  const names = Array.isArray(r.student_names) ? r.student_names : [];
  return {
    id: r.id,
    date: r.date,
    start: r.start_time,
    end: r.end_time,
    venue_id: r.venue_id,
    coach: r.coach || '',              // 教練全名：救生員要對得到人，遮了就沒用
    course_type: r.course_type,
    is_experience_course: !!r.is_experience_course,
    student_count: names.length,
    students: names.map(maskStudentName), // 「林同學」——對得出是哪一組，不外洩全名
    checkin_status: r.checkin_status,
    checkin_at: r.checkin_at || null,
  };
}

// ── GET /sessions ───────────────────────────────────────────
router.get('/sessions', requireIntegrationKey, async (req, res) => {
  try {
    const venueId = String(req.query.venue_id || '').trim();
    // 一定要指定場館：不接受裸查詢。「可以整包枚舉」正是公開 API 那次真正的漏洞，
    // 欄位遮乾淨了但整份名冊還是能被抓走。
    if (!venueId) {
      return res.status(400).json({ error: '必須指定 venue_id', code: 'VENUE_REQUIRED' });
    }
    const allowed = req.integration.venueIds;
    if (allowed && !allowed.includes(venueId)) {
      logAccess({
        label: req.integration.label,
        action: '整合 API 存取越權場館',
        severity: 'warning',
        details: { requested: venueId, allowed },
      });
      return res.status(403).json({ error: '此金鑰無權查詢該場館', code: 'VENUE_OUT_OF_SCOPE' });
    }

    let from;
    let to;
    let mode;
    const dateParam = String(req.query.date || '').trim();
    if (dateParam) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        return res.status(400).json({ error: 'date 格式需為 YYYY-MM-DD', code: 'DATE_INVALID' });
      }
      const day = new Date(`${dateParam}T00:00:00+08:00`);
      if (Number.isNaN(day.getTime())) {
        return res.status(400).json({ error: 'date 不是有效日期', code: 'DATE_INVALID' });
      }
      const offsetDays = Math.abs(day.getTime() - Date.now()) / 86400000;
      if (offsetDays > MAX_DATE_OFFSET_DAYS + 1) {
        return res.status(400).json({
          error: `只能查詢前後 ${MAX_DATE_OFFSET_DAYS} 天內的日期`,
          code: 'DATE_OUT_OF_RANGE',
        });
      }
      from = day;
      to = new Date(day.getTime() + 86400000);
      mode = 'date';
    } else {
      const raw = Number(req.query.window);
      const windowMin = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_WINDOW_MIN) : DEFAULT_WINDOW_MIN;
      const now = Date.now();
      from = new Date(now - windowMin * 60000);
      to = new Date(now + windowMin * 60000);
      mode = `window:${windowMin}`;
    }

    const r = await pool.query(SESSIONS_SQL, [venueId, from.toISOString(), to.toISOString()]);
    const sessions = r.rows.map(shapeSession);

    logAccess({
      label: req.integration.label,
      action: '整合 API 查詢上課紀錄',
      severity: 'info',
      details: { venue_id: venueId, mode, count: sessions.length },
    });

    const v = await pool.query('SELECT name FROM venues WHERE id = $1', [venueId]);
    res.json({
      venue_id: venueId,
      venue_name: v.rows[0]?.name || null,
      // 伺服器時間一起回：現場頁面用它判斷「現在」，不靠平板自己的時鐘
      //（平板時間跑掉是很常見的事，會讓人以為課程消失了）。
      server_time: new Date().toISOString(),
      range: { from: from.toISOString(), to: to.toISOString() },
      count: sessions.length,
      sessions,
    });
  } catch (err) {
    console.error('[integrations/sessions]', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.__test__ = { shapeSession, SESSIONS_SQL, MAX_WINDOW_MIN, MAX_DATE_OFFSET_DAYS };
module.exports = router;
