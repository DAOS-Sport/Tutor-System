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
      `cpe.status = 'active'`,
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

/**
 * GET /api/courses/mine — 家長查看所有報名（admin_enrollments）
 * 支援主要手機 OR extra_parent_phones（多組家庭同組）
 * requireParent 後 req.parent.phone 由 JWT 帶入
 */
router.get('/mine', requireParent, async (req, res) => {
  try {
    const phone = req.parent.phone;
    const r = await pool.query(
      `SELECT id, parent_name, parent_phone, students, coach, venue_id, course_type,
              original_price, final_price, transfer_last_5, status, submitted_at,
              total_sessions, used_sessions, refund_amount,
              invoice_number, invoice_image_url, invoice_url, invoice_issued_at,
              extra_parent_phones, notes
         FROM admin_enrollments
        WHERE parent_phone = $1 OR $1 = ANY(extra_parent_phones)
        ORDER BY submitted_at DESC`,
      [phone]
    );
    res.json(r.rows.map((row) => ({
      id: row.id,
      parent_name: row.parent_name,
      parent_phone: row.parent_phone,
      students: row.students || [],
      coach: row.coach,
      venue_id: row.venue_id,
      course_type: row.course_type,
      original_price: Number(row.original_price),
      final_price: Number(row.final_price),
      transfer_last_5: row.transfer_last_5,
      payment_status: row.status,
      submitted_at: row.submitted_at,
      total_sessions: row.total_sessions,
      used_sessions: row.used_sessions,
      refund_amount: row.refund_amount != null ? Number(row.refund_amount) : null,
      invoice_number: row.invoice_number || null,
      invoice_image_url: row.invoice_image_url || null,
      invoice_url: row.invoice_url || null,
      invoice_issued_at: row.invoice_issued_at || null,
      extra_parent_phones: row.extra_parent_phones || [],
      notes: row.notes || null,
    })));
  } catch (e) {
    console.error('[courses/mine]', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/courses/types — 公開：LIFF 報名頁的組別卡片只顯示 is_active=true
 * 表 course_type_configs 由後台「課程需求管理」維護（F-A07）。
 */
router.get('/types', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT course_type, label, max_students, is_active, sort_order
         FROM course_type_configs
        WHERE is_active = TRUE
        ORDER BY sort_order, course_type`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[courses/types]', e);
    res.status(500).json({ error: e.message });
  }
});

router.all('*', (req, res) => {
  res.status(501).json({ error: 'Not implemented', module: 'courses', path: req.path });
});

module.exports = router;
