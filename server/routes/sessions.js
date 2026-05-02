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

router.get('/coach/:coachId/today', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cs.id, cs.scheduled_at, cs.duration_minutes, cs.status,
              cp.id AS course_period_id, cp.course_type,
              v.id AS venue_id, v.name AS venue_name,
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
       WHERE cp.coach_id = $1
         AND cs.scheduled_at::date = CURRENT_DATE
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
              COALESCE(
                (SELECT json_agg(s.name ORDER BY s.name)
                 FROM course_period_enrollments cpe
                 JOIN students s ON s.id = cpe.student_id
                 WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'),
                '[]'::json
              ) AS student_names
       FROM course_sessions cs
       JOIN course_periods cp ON cs.course_period_id = cp.id
       WHERE cp.coach_id = $1
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

router.get('/:id', requireCoach, async (req, res) => {
  try {
    // 同時驗證所屬教練 — 若不是本人課程一律 403
    const own = await pool.query(
      `SELECT 1 FROM course_sessions cs JOIN course_periods cp ON cs.course_period_id = cp.id
       WHERE cs.id = $1 AND cp.coach_id = $2`,
      [req.params.id, req.coach.id]
    );
    if (own.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
    const r = await pool.query(
      `SELECT cs.*, cp.course_type, cp.venue_id, v.name AS venue_name,
              COALESCE(
                (SELECT json_agg(s.name ORDER BY s.name)
                 FROM course_period_enrollments cpe
                 JOIN students s ON s.id = cpe.student_id
                 WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'),
                '[]'::json
              ) AS student_names
       FROM course_sessions cs
       JOIN course_periods cp ON cs.course_period_id = cp.id
       JOIN venues v ON v.id = cp.venue_id
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
