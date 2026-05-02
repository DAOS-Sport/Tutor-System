/**
 * 教練可用時段（coach_availability_slots）API
 * - GET    /api/slots/coach/:coachId           ?from=YYYY-MM-DD&to=YYYY-MM-DD（預設本週）
 * - POST   /api/slots                          { coach_id, venue_id, start_at, duration_minutes, notes }
 * - POST   /api/slots/batch                    { coach_id, venue_id, weekdays:[0..6], times:[HH:mm], from, to, duration_minutes }
 * - PATCH  /api/slots/:id/block                封鎖（available → blocked）
 * - PATCH  /api/slots/:id/unblock              解封（blocked → available）
 * - DELETE /api/slots/:id                      刪除（僅 available）
 * - POST   /api/slots/preview-conflict         { coach_id, start_at, duration_minutes }
 *
 * 全部端點皆要求教練 JWT。寫入端點額外驗證 body.coach_id (或 slot.coach_id) 與 token coachId 一致。
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { detectConflict, createSlot, batchCreateSlots } = require('../services/slots');
const { requireCoach, requireCoachOwner } = require('../middlewares/coachAuth');

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay()); // 週日為起
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function ensureBodyOwner(req, res, next) {
  const cid = req.body?.coach_id;
  if (!cid || String(cid) !== String(req.coach?.id)) {
    return res.status(403).json({ error: 'Forbidden: body.coach_id mismatch' });
  }
  next();
}

async function ensureSlotOwner(req, res, next) {
  try {
    const r = await pool.query(
      'SELECT coach_id FROM coach_availability_slots WHERE id = $1',
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'slot not found' });
    if (String(r.rows[0].coach_id) !== String(req.coach?.id)) {
      return res.status(403).json({ error: 'Forbidden: slot belongs to another coach' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// 取教練槽位 + 已 booked 的 session 細節（學員姓名）
router.get('/coach/:coachId', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  const { coachId } = req.params;
  const { from, to } = req.query;
  const fromDate = from ? new Date(from) : startOfWeek(new Date());
  const toDate = to ? new Date(to) : addDays(fromDate, 7);
  try {
    const r = await pool.query(
      `SELECT cas.id, cas.coach_id, cas.venue_id, v.name AS venue_name,
              cas.start_at, cas.duration_minutes, cas.status, cas.notes,
              cas.booked_session_id,
              cs.id AS session_id, cs.course_period_id,
              cp.course_type,
              COALESCE(
                (SELECT json_agg(s.name ORDER BY s.name)
                 FROM course_period_enrollments cpe
                 JOIN students s ON s.id = cpe.student_id
                 WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'),
                '[]'::json
              ) AS student_names
       FROM coach_availability_slots cas
       JOIN venues v ON v.id = cas.venue_id
       LEFT JOIN course_sessions cs ON cs.id = cas.booked_session_id
       LEFT JOIN course_periods cp ON cp.id = cs.course_period_id
       WHERE cas.coach_id = $1
         AND cas.start_at >= $2
         AND cas.start_at < $3
       ORDER BY cas.start_at`,
      [coachId, fromDate.toISOString(), toDate.toISOString()]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[slots] list failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireCoach, ensureBodyOwner, async (req, res) => {
  const { coach_id, venue_id, start_at, duration_minutes = 60, notes = null } = req.body || {};
  if (!coach_id || !venue_id || !start_at) {
    return res.status(400).json({ error: 'coach_id / venue_id / start_at 必填' });
  }
  try {
    const slot = await createSlot({ coachId: coach_id, venueId: venue_id, startAt: start_at, durationMinutes: duration_minutes, notes });
    res.status(201).json(slot);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

router.post('/batch', requireCoach, ensureBodyOwner, async (req, res) => {
  const { coach_id, venue_id, weekdays, times, from, to, duration_minutes = 60 } = req.body || {};
  if (!coach_id || !venue_id || !Array.isArray(weekdays) || !Array.isArray(times) || !from || !to) {
    return res.status(400).json({ error: '需要 coach_id, venue_id, weekdays[], times[], from, to' });
  }
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const slots = [];
  for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
    if (!weekdays.includes(d.getDay())) continue;
    for (const t of times) {
      const [hh, mm] = t.split(':').map(Number);
      const startAt = new Date(d);
      startAt.setHours(hh, mm || 0, 0, 0);
      slots.push({ coachId: coach_id, venueId: venue_id, startAt: startAt.toISOString(), durationMinutes: duration_minutes });
    }
  }
  try {
    const result = await batchCreateSlots(slots);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/block', requireCoach, ensureSlotOwner, async (req, res) => {
  const r = await pool.query(
    `UPDATE coach_availability_slots SET status = 'blocked', updated_at = NOW()
     WHERE id = $1 AND status = 'available' RETURNING *`,
    [req.params.id]
  );
  if (r.rows.length === 0) return res.status(409).json({ error: '只有 available 槽位可封鎖' });
  res.json(r.rows[0]);
});

router.patch('/:id/unblock', requireCoach, ensureSlotOwner, async (req, res) => {
  const r = await pool.query(
    `UPDATE coach_availability_slots SET status = 'available', updated_at = NOW()
     WHERE id = $1 AND status = 'blocked' RETURNING *`,
    [req.params.id]
  );
  if (r.rows.length === 0) return res.status(409).json({ error: '只有 blocked 槽位可解封' });
  res.json(r.rows[0]);
});

router.delete('/:id', requireCoach, ensureSlotOwner, async (req, res) => {
  const r = await pool.query(
    `DELETE FROM coach_availability_slots WHERE id = $1 AND status = 'available' RETURNING id`,
    [req.params.id]
  );
  if (r.rows.length === 0) return res.status(409).json({ error: '只有 available 槽位可刪除' });
  res.json({ ok: true, id: req.params.id });
});

router.post('/preview-conflict', requireCoach, ensureBodyOwner, async (req, res) => {
  const { coach_id, start_at, duration_minutes = 60 } = req.body || {};
  if (!coach_id || !start_at) return res.status(400).json({ error: 'coach_id / start_at 必填' });
  const conflicts = await detectConflict(coach_id, start_at, duration_minutes);
  res.json({ has_conflict: conflicts.length > 0, conflicts });
});

module.exports = router;
