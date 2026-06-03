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
const { detectConflict, createSlot, batchCreateSlots, bookSlot1v1, bookSlot1vN } = require('../services/slots');
const { requireCoach, requireCoachOwner } = require('../middlewares/coachAuth');
const { requireParent } = require('../middlewares/parentAuth');

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

// ── 家長端：選槽建立 session（架構 v7 §9.2「課程開通後選擇上課時間」）─────────
//   POST /api/slots/:id/book   body { course_period_id }
//   :id = coach_availability_slots.id（要預約的可用時段）
//
//   只新增此家長路由，完全不更動上方教練端路由。流程：
//   1) 鎖該教練（與教練開槽用同一把 advisory lock，序列化避免雙訂）
//   2) 驗證家長確實擁有該 course_period（透過 course_period_enrollments→students.parent_id）
//   3) 驗證 period 為 active、未超過已購堂數、slot 與 period 的教練/場館一致
//   4) 依「同期家庭數」分流：單一家庭→bookSlot1v1 即時 confirmed；
//      多家庭（團報共享）→bookSlot1vN 暫鎖待同組確認
//   注意：選槽「不」異動 used_sessions——全系統堂數以 checkin_records 為準
//   （cron/index.js:204），used_sessions 無任何 +1 處，動它會破壞既有計數。
router.post('/:id/book', requireParent, async (req, res) => {
  const slotId = req.params.id;
  const coursePeriodId = req.body?.course_period_id ? String(req.body.course_period_id) : '';
  if (!coursePeriodId) return res.status(400).json({ error: 'course_period_id 必填' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) 取槽位（拿 coach_id/venue_id 供上鎖與一致性檢查）
    const slotRes = await client.query(
      `SELECT id, coach_id, venue_id, status FROM coach_availability_slots WHERE id = $1`,
      [slotId]
    );
    if (!slotRes.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '時段不存在' }); }
    const slot = slotRes.rows[0];

    // 與教練開槽用同一把鎖，序列化「檢查 + 建 session」避免並發雙訂
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(slot.coach_id)]);

    // 2) 取課程期
    const cpRes = await client.query(
      `SELECT id, coach_id, venue_id, course_type, status, total_sessions
         FROM course_periods WHERE id = $1`,
      [coursePeriodId]
    );
    if (!cpRes.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '課程期不存在' }); }
    const cp = cpRes.rows[0];

    // 3) 驗證家長擁有此課程期（名下任一在籍學員屬於此期）
    const own = await client.query(
      `SELECT 1 FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
        WHERE cpe.course_period_id = $1 AND s.parent_id = $2 AND cpe.status = 'active'
        LIMIT 1`,
      [coursePeriodId, req.parent.id]
    );
    if (!own.rowCount) { await client.query('ROLLBACK'); return res.status(403).json({ error: '無權預約此課程期' }); }

    // 4) period 狀態 / 容量 / 槽位一致性
    if (cp.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此課程期尚未開通或已結束', code: 'PERIOD_NOT_ACTIVE' });
    }
    if (slot.coach_id !== cp.coach_id || String(slot.venue_id) !== String(cp.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此時段與課程期的教練或場館不符', code: 'SLOT_MISMATCH' });
    }
    if (slot.status !== 'available') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此時段已被預約或不可選', code: 'SLOT_UNAVAILABLE' });
    }
    // 容量：已排（未取消）堂數不得超過已購買 total_sessions
    const used = await client.query(
      `SELECT COUNT(*)::int AS n FROM course_sessions
        WHERE course_period_id = $1 AND status NOT LIKE 'cancelled%'`,
      [coursePeriodId]
    );
    if (used.rows[0].n >= cp.total_sessions) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '可預約堂數已用完', code: 'NO_SESSIONS_LEFT' });
    }

    // 5) 分流：同期不同家庭數 → 1v1 即時確認 / 1vN 暫鎖待同組確認
    const fam = await client.query(
      `SELECT DISTINCT s.parent_id
         FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
        WHERE cpe.course_period_id = $1 AND cpe.status = 'active'`,
      [coursePeriodId]
    );
    const groupParentIds = fam.rows.map((r) => r.parent_id);

    let session;
    if (groupParentIds.length <= 1) {
      session = await bookSlot1v1(slotId, coursePeriodId, client);
    } else {
      session = await bookSlot1vN(slotId, coursePeriodId, req.parent.id, groupParentIds, client);
    }

    await client.query('COMMIT');
    res.status(201).json({ session });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // bookSlot* 在槽位已被搶走時 throw（'此時段已被預約或不存在'）→ 視為 409
    if (/已被預約|不存在/.test(err.message || '')) {
      return res.status(409).json({ error: '此時段已被預約，請改選其他時段', code: 'SLOT_TAKEN' });
    }
    console.error('[slots parent book]', err);
    res.status(500).json({ error: '預約失敗' });
  } finally {
    client.release();
  }
});

module.exports = router;
