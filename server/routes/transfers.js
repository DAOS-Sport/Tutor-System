/**
 * 課程轉讓 (家長端) — F-S08
 *   POST /api/transfers           送出申請
 *   GET  /api/transfers/mine      自己的申請紀錄
 */
const express = require('express');
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const transfers = require('../services/transfers');
const line = require('../services/line');

const router = express.Router();
router.use(requireParent);

router.get('/mine', async (req, res) => {
  try {
    const list = await transfers.listMine(req.parent.id);
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const { period_id, from_student_id, to_phone, to_student_name, reason } = req.body || {};
  if (!period_id || !from_student_id || !to_phone) {
    return res.status(400).json({ error: 'period_id / from_student_id / to_phone 必填' });
  }
  if (!/^09\d{8}$/.test(String(to_phone))) {
    return res.status(400).json({ error: '轉入方手機格式錯誤' });
  }
  try {
    const t = await transfers.createRequest({
      parentId: req.parent.id, periodId: period_id, fromStudentId: from_student_id,
      toPhone: to_phone, toStudentName: to_student_name, reason,
    });
    // 推播給轉入方（若已是會員）
    try {
      const target = await pool.query(`SELECT line_uid FROM parents WHERE phone = $1`, [to_phone]);
      const meta = await pool.query(
        `SELECT co.name AS coach_name, cp.venue_id, cp.course_type, fp.name AS from_name
           FROM course_periods cp JOIN coaches co ON co.id=cp.coach_id
           JOIN parents fp ON fp.id = $1 WHERE cp.id = $2`,
        [req.parent.id, period_id]
      );
      const uid = target.rows[0]?.line_uid;
      const m = meta.rows[0];
      if (uid && m) {
        const courseInfo = `${m.coach_name} 教練・1 對 ${m.course_type}`;
        const msg = line.templates.transferRequest({
          fromParentName: m.from_name,
          courseInfo, sessionsRemaining: t.sessions_remaining,
        });
        await line.pushMessage(uid, msg, m.venue_id);
      }
    } catch (err) {
      console.warn('[transfers] notify recipient failed:', err.message);
    }
    res.status(201).json(t);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.patch('/:id/cancel', async (req, res) => {
  try {
    const r = await transfers.cancel({ id: req.params.id, parentId: req.parent.id });
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
