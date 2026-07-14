/**
 * Task #60：GET /api/admin/checkins?venueId=&date=YYYY-MM-DD
 *  - 列出指定日期已簽到名單（最新在最上方）。預設為今日。
 *  - staff 強制鎖在自己場館。
 *  - 同時讀 checkin_records（學員自助/教練端）與 admin_enrollments.experience_checked_in_at（體驗課），
 *    後者轉成同一格式，避免兩種來源畫面分裂。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole, getScopedVenueIds } = require('../../middlewares/adminAuth');

const router = express.Router();

// 以「Asia/Taipei (UTC+8)」為營運日期基準，避免 UTC 半夜跨日造成漏單
const TZ = 'Asia/Taipei';
function todayInTaipei() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date()); // YYYY-MM-DD
}

router.get('/', requireAdminAuth, async (req, res) => {
  try {
    const date = String(req.query.date || '').trim() || todayInTaipei();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date format YYYY-MM-DD required' });
    // Task #90：staff/manager 鎖自己所屬全部場館；admin 可帶 venueId 縮小
    const scope = getScopedVenueIds(req);
    let venueIds = null;
    if (scope) {
      venueIds = scope;
      if (req.query.venueId && scope.includes(String(req.query.venueId))) {
        venueIds = [String(req.query.venueId).trim()];
      }
    } else if (req.query.venueId) {
      venueIds = [String(req.query.venueId).trim()];
    }

    const args = [date];
    let venueWhere = '';
    if (venueIds) { args.push(venueIds); venueWhere = ` AND cp.venue_id = ANY($${args.length}::text[])`; }
    const recSql = `
      SELECT cr.id            AS checkin_id,
             cr.checked_in_at AS at,
             cr.checked_in_source AS source,
             cs.created_via   AS session_created_via,
             cs.id            AS session_id,
             cp.venue_id      AS venue_id,
             v.name           AS venue_name,
             cp.course_type   AS course_type,
             c.name           AS coach_name,
             s.name           AS student_name,
             cp.id            AS period_id
        FROM checkin_records cr
        JOIN course_sessions cs ON cs.id = cr.course_session_id
        JOIN course_periods  cp ON cp.id = cs.course_period_id
        JOIN students        s  ON s.id  = cr.student_id
   LEFT JOIN coaches         c  ON c.id  = cp.coach_id
   LEFT JOIN admin_venues    v  ON v.id  = cp.venue_id
       WHERE (cr.checked_in_at AT TIME ZONE 'Asia/Taipei')::date = $1::date
         ${venueWhere}
    `;
    const r1 = await pool.query(recSql, args);

    const args2 = [date];
    let venueWhere2 = '';
    if (venueIds) { args2.push(venueIds); venueWhere2 = ` AND ae.venue_id = ANY($${args2.length}::text[])`; }
    const expSql = `
      SELECT ae.id || ':' || extract(epoch from ae.experience_checked_in_at)::bigint AS checkin_id,
             ae.experience_checked_in_at AS at,
             'staff'::text               AS source,
             'booking'::text             AS session_created_via,
             NULL::uuid                  AS session_id,
             ae.venue_id                 AS venue_id,
             v.name                      AS venue_name,
             ae.course_type              AS course_type,
             ae.coach                    AS coach_name,
             COALESCE(array_to_string(ae.students, '、'), '') AS student_name,
             ae.id                       AS period_id
        FROM admin_enrollments ae
   LEFT JOIN admin_venues      v ON v.id = ae.venue_id
       WHERE ae.experience_checked_in_at IS NOT NULL
         AND (ae.experience_checked_in_at AT TIME ZONE 'Asia/Taipei')::date = $1::date
         ${venueWhere2}
    `;
    const r2 = await pool.query(expSql, args2);

    const all = [...r1.rows, ...r2.rows]
      .map((r) => ({
        checkin_id: r.checkin_id,
        at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
        session_id: r.session_id,
        period_id: r.period_id,
        venue_id: r.venue_id,
        venue_name: r.venue_name || r.venue_id,
        course_type: Number(r.course_type) || null,
        coach: r.coach_name || '',
        student: r.student_name || '',
        source: r.source || null,
        session_created_via: r.session_created_via || 'booking',
      }))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    res.json(all);
  } catch (err) {
    console.error('[admin/checkins]', err);
    res.status(500).json({ error: 'load checkins failed' });
  }
});

/**
 * U13 撤銷自助簽到（櫃檯更正入口——家長端不開放自撤，誤點一律走這裡）。
 *  DELETE /api/admin/checkins/self-sessions/:sessionId
 *  - 僅限 created_via='self_checkin' 的課堂（預約制課堂不可用此路徑刪）。
 *  - 刪除該堂全部簽到 → 課堂轉 cancelled_normal → self_checkin_date 清 NULL
 *    （釋放「每日一次」名額，家長當天可重簽正確內容）。
 *  - 教練已寫上課紀錄（session_records）→ 409 擋下，避免默默孤兒化教學紀錄。
 *  - audit 掛 period anchor 報名單，堂數即時歸還（堂數真相=checkin_records，刪即還）。
 */
router.delete('/self-sessions/:sessionId', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT cs.id, cs.created_via, cs.status::text AS status, cs.course_period_id,
              cp.venue_id, cp.admin_enrollment_id
         FROM course_sessions cs
         JOIN course_periods cp ON cp.id = cs.course_period_id
        WHERE cs.id = $1
        FOR UPDATE OF cs`,
      [req.params.sessionId]
    );
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到課堂' });
    }
    const row = cur.rows[0];
    const scope = getScopedVenueIds(req);
    if (scope && !scope.includes(row.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此課堂不在您的場館範圍內' });
    }
    if (row.created_via !== 'self_checkin') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '僅自助簽到課堂可用此方式撤銷', code: 'NOT_SELF_CHECKIN' });
    }
    if (['cancelled_normal', 'cancelled_penalty'].includes(row.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '此課堂已撤銷', code: 'ALREADY_REVOKED' });
    }
    const hasRecord = await client.query(
      `SELECT 1 FROM session_records WHERE course_session_id = $1 LIMIT 1`,
      [req.params.sessionId]
    );
    if (hasRecord.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '教練已填寫此堂上課紀錄，請先與教練確認後再處理', code: 'SESSION_RECORD_EXISTS' });
    }

    const delCk = await client.query(
      `DELETE FROM checkin_records WHERE course_session_id = $1`,
      [req.params.sessionId]
    );
    await client.query(
      `UPDATE course_sessions
          SET status = 'cancelled_normal', cancelled_at = NOW(), self_checkin_date = NULL, updated_at = NOW()
        WHERE id = $1`,
      [req.params.sessionId]
    );
    if (row.admin_enrollment_id) {
      const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
         SELECT id, $2, $3 FROM admin_enrollments WHERE id = $1`,
        [row.admin_enrollment_id,
         `撤銷自助簽到（課堂 ${req.params.sessionId}，移除 ${delCk.rowCount} 筆簽到，堂數已歸還）`, by]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, session_id: req.params.sessionId, removed_checkins: delCk.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/checkins/self-sessions delete]', err);
    res.status(500).json({ error: 'revoke self checkin failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
