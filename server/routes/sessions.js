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

function todayWhereTaipei(columnSql = 'cs.scheduled_at') {
  return `(${columnSql} AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date`;
}

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
              EXISTS(SELECT 1 FROM checkin_records WHERE course_session_id = cs.id) AS checked_in
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
  const fromD = from ? new Date(from) : (() => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - d.getDay()); return d; })();
  const toD = to ? new Date(to) : new Date(fromD.getTime() + 7 * 24 * 3600 * 1000);
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

router.post('/:id/checkins', requireCoach, async (req, res) => {
  const studentId = String(req.body?.studentId || '').trim();
  if (!studentId) return res.status(400).json({ error: 'studentId required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ctx = await client.query(
      `SELECT cs.id AS session_id, cs.status::text AS session_status,
              cp.id AS period_id, cp.venue_id, cp.course_type,
              COALESCE(cs.coach_id, cp.coach_id) AS coach_id,
              c.name AS coach_name, v.name AS venue_name
         FROM course_sessions cs
         JOIN course_periods cp ON cp.id = cs.course_period_id
         LEFT JOIN coaches c ON c.id = COALESCE(cs.coach_id, cp.coach_id)
         LEFT JOIN venues v ON v.id = cp.venue_id
        WHERE cs.id = $1`,
      [req.params.id]
    );
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

    const ins = await client.query(
      `INSERT INTO checkin_records
         (course_session_id, student_id, checked_in_source, checked_in_by_coach_id)
       VALUES ($1, $2, 'coach', $3)
       ON CONFLICT (course_session_id, student_id) DO UPDATE SET checked_in_at = checkin_records.checked_in_at
       RETURNING id, checked_in_at, checked_in_source`,
      [req.params.id, studentId, req.coach.id]
    );
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
