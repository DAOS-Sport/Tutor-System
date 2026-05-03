/**
 * 家長端課程查詢 (F-S07 上課記錄)
 *   GET /api/courses/lessons   登入家長的所有上課記錄（含已簽到）
 */
const express = require('express');
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');

const router = express.Router();

router.get('/lessons', requireParent, async (req, res) => {
  try {
    // F-S07 篩選：from / to (日期) / coachId / courseType (1對1=group, 1對2..)
    const args = [req.parent.id];
    const conds = [
      `s.parent_id = $1`,
      `cs.status IN ('confirmed','completed','pending_group_confirm')`,
    ];
    if (req.query.from) {
      args.push(req.query.from);
      conds.push(`cs.scheduled_at >= $${args.length}::date`);
    }
    if (req.query.to) {
      args.push(req.query.to);
      conds.push(`cs.scheduled_at < ($${args.length}::date + INTERVAL '1 day')`);
    }
    if (req.query.coachId) {
      args.push(req.query.coachId);
      conds.push(`cp.coach_id = $${args.length}`);
    }
    if (req.query.courseType) {
      args.push(req.query.courseType);
      conds.push(`cp.course_type = $${args.length}`);
    }
    const r = await pool.query(
      `SELECT cs.id AS session_id,
              cs.scheduled_at,
              cs.status AS session_status,
              cp.id AS period_id,
              cp.course_type,
              cp.venue_id,
              co.id AS coach_id, co.name AS coach_name,
              s.id AS student_id, s.name AS student_name,
              cr.id AS checkin_id, cr.checked_in_at,
              sr.id AS record_id, sr.status AS record_status
         FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
         JOIN course_periods cp ON cp.id = cpe.course_period_id
         JOIN coaches co ON co.id = cp.coach_id
         JOIN course_sessions cs ON cs.course_period_id = cp.id
         LEFT JOIN checkin_records cr ON cr.course_session_id = cs.id AND cr.student_id = s.id
         LEFT JOIN session_records sr ON sr.course_session_id = cs.id
        WHERE ${conds.join(' AND ')}
        ORDER BY cs.scheduled_at DESC
        LIMIT 500`,
      args
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.all('*', (req, res) => {
  res.status(501).json({ error: 'Not implemented', module: 'courses', path: req.path });
});

module.exports = router;
