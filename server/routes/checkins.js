/**
 * Task #60：學員自助報到（LIFF 端）
 *  POST /api/checkins  { sessionId, studentId }
 *    - 寫入 checkin_records（UNIQUE: session+student → 重複時回傳既有 row，不報錯）
 *    - 廣播 admin WS 事件 'checkin:created'
 *    - 需要家長 JWT；驗證 student 屬於 req 的 parent
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const { broadcastAdminEvent } = require('../services/websocket');

router.post('/', requireParent, async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const studentId = String(req.body?.studentId || '').trim();
  if (!sessionId || !studentId) return res.status(400).json({ error: 'sessionId/studentId required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 驗證 student 屬於該 parent
    const own = await client.query(
      `SELECT 1 FROM students WHERE id = $1 AND parent_id = $2`,
      [studentId, req.parent.id]
    );
    if (!own.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '學員不屬於該家長' });
    }
    // 驗證 session 存在 + 取上下文 + 該 student 必須是該 course_period 的 enrollment 名單成員
    const ctx = await client.query(
      `SELECT cs.id AS session_id, cp.id AS period_id, cp.venue_id, cp.course_type, cp.coach_id,
              c.name AS coach_name, v.name AS venue_name, s.name AS student_name
         FROM course_sessions cs
         JOIN course_periods  cp ON cp.id = cs.course_period_id
         JOIN students        s  ON s.id  = $2
    LEFT JOIN coaches      c  ON c.id  = cp.coach_id
    LEFT JOIN admin_venues v  ON v.id  = cp.venue_id
        WHERE cs.id = $1
          AND EXISTS (
                SELECT 1 FROM course_period_enrollments cpe
                 WHERE cpe.course_period_id = cp.id AND cpe.student_id = $2
              )`,
      [sessionId, studentId]
    );
    if (!ctx.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '該學員未在此課程名單中' });
    }

    const ins = await client.query(
      `INSERT INTO checkin_records
         (course_session_id, student_id, checked_in_source, checked_in_by_parent_id)
       VALUES ($1, $2, 'parent', $3)
       ON CONFLICT (course_session_id, student_id) DO UPDATE SET checked_in_at = checkin_records.checked_in_at
       RETURNING id, checked_in_at, checked_in_source`,
      [sessionId, studentId, req.parent.id]
    );
    await client.query('COMMIT');

    const row = ins.rows[0];
    const x = ctx.rows[0];
    try {
      broadcastAdminEvent('checkin:created', {
        checkin_id: row.id,
        at: row.checked_in_at instanceof Date ? row.checked_in_at.toISOString() : String(row.checked_in_at),
        session_id: sessionId,
        period_id: x.period_id,
        venue_id: x.venue_id,
        venue_name: x.venue_name || x.venue_id,
        course_type: Number(x.course_type) || null,
        coach: x.coach_name || '',
        student: x.student_name || '',
        source: row.checked_in_source || 'parent',
      });
    } catch (e) { console.warn('[checkins] broadcast skipped:', e?.message); }

    res.json({ ok: true, checkin_id: row.id, checked_in_at: row.checked_in_at, source: row.checked_in_source || 'parent' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[checkins POST]', err);
    res.status(500).json({ error: 'checkin failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
