'use strict';
/**
 * 場館營業時間（模組 1 / migration 038）
 *
 *   GET    /api/admin/venue-hours              全部場館的營業時間
 *   PUT    /api/admin/venue-hours/:venueId     覆寫該場館的整週設定（單一交易）
 *
 * 權限：系統管理員與場館主管（使用者決策 2026-08-03）。櫃檯不可改。
 *
 * 這是自動時段產生器的唯一時間來源（services/slotGenerator.js），
 * 改動會影響隔日 02:30 產生的時段，因此寫入端要求 admin/manager 並留稽核。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();
const AM = requireAdminRole('admin', 'manager');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 驗證單日設定（純資料檢查，錯誤一次回報完整清單，不逐項打斷）。 */
function validateRow(r, idx) {
  const errs = [];
  const wd = Number(r?.weekday);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) errs.push(`第 ${idx + 1} 筆：weekday 必須是 0~6`);
  if (!TIME_RE.test(String(r?.open_time || ''))) errs.push(`第 ${idx + 1} 筆：open_time 格式須為 HH:MM`);
  if (!TIME_RE.test(String(r?.close_time || ''))) errs.push(`第 ${idx + 1} 筆：close_time 格式須為 HH:MM`);
  if (TIME_RE.test(String(r?.open_time || '')) && TIME_RE.test(String(r?.close_time || ''))
      && String(r.close_time) <= String(r.open_time)) {
    errs.push(`第 ${idx + 1} 筆：打烊時間必須晚於開店時間`);
  }
  const step = Number(r?.slot_minutes ?? 60);
  if (!Number.isInteger(step) || step <= 0 || step > 480) errs.push(`第 ${idx + 1} 筆：slot_minutes 需為 1~480 的整數`);
  return errs;
}

router.get('/', requireAdminAuth, AM, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, b.venue_id, v.name AS venue_name, b.weekday,
              to_char(b.open_time,'HH24:MI')  AS open_time,
              to_char(b.close_time,'HH24:MI') AS close_time,
              b.slot_minutes, b.is_active, b.updated_at
         FROM venue_business_hours b
         JOIN venues v ON v.id = b.venue_id
        ORDER BY b.venue_id, b.weekday, b.open_time`
    );
    // 順便回傳「還沒設定營業時間」的啟用場館，避免櫃檯以為設好了其實漏了
    const missing = await pool.query(
      `SELECT v.id, v.name FROM venues v
        WHERE v.is_active
          AND NOT EXISTS (SELECT 1 FROM venue_business_hours b WHERE b.venue_id = v.id AND b.is_active)
        ORDER BY v.id`
    );
    res.json({ hours: r.rows, venues_without_hours: missing.rows });
  } catch (err) {
    console.error('[admin/venue-hours list]', err.message);
    res.status(500).json({ error: '讀取場館營業時間失敗' });
  }
});

router.put('/:venueId', requireAdminAuth, AM, async (req, res) => {
  const venueId = String(req.params.venueId || '').trim();
  const rows = Array.isArray(req.body?.hours) ? req.body.hours : null;
  if (!rows) return res.status(400).json({ error: 'hours 必須是陣列', code: 'INPUT_INVALID' });

  const errs = rows.flatMap((r, i) => validateRow(r, i));
  // 同一天同一開店時間重複 → UNIQUE 會擋，但先在應用層講清楚是哪一筆
  const seen = new Set();
  rows.forEach((r, i) => {
    const k = `${r?.weekday}|${r?.open_time}`;
    if (seen.has(k)) errs.push(`第 ${i + 1} 筆：同一天的同一開店時間重複`);
    seen.add(k);
  });
  if (errs.length) return res.status(400).json({ error: errs.join('；'), code: 'INPUT_INVALID', details: errs });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const v = await client.query(`SELECT id FROM venues WHERE id = $1`, [venueId]);
    if (!v.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '找不到此場館' }); }

    // 整週覆寫：先清該館舊設定再寫入，避免「刪掉某天」變成改不掉的殘留。
    await client.query(`DELETE FROM venue_business_hours WHERE venue_id = $1`, [venueId]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO venue_business_hours (venue_id, weekday, open_time, close_time, slot_minutes, is_active)
         VALUES ($1,$2,$3::time,$4::time,$5,$6)`,
        [venueId, Number(r.weekday), r.open_time, r.close_time,
          Number(r.slot_minutes ?? 60), r.is_active !== false]
      );
    }
    await client.query('COMMIT');

    const after = await pool.query(
      `SELECT weekday, to_char(open_time,'HH24:MI') AS open_time,
              to_char(close_time,'HH24:MI') AS close_time, slot_minutes, is_active
         FROM venue_business_hours WHERE venue_id = $1 ORDER BY weekday, open_time`, [venueId]);
    res.json({ ok: true, venue_id: venueId, hours: after.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/venue-hours put]', err.message);
    res.status(500).json({ error: '儲存場館營業時間失敗' });
  } finally {
    client.release();
  }
});

// ── 特殊日期休館（migration 041）──────────────────────────────────
//   GET    /api/admin/venue-hours/closed-dates?venueId=&from=&to=
//   POST   /api/admin/venue-hours/closed-dates      { venue_id, closed_date, reason }
//   DELETE /api/admin/venue-hours/closed-dates/:id
//
//   只記「關閉」不記「加開」：加開屬臨時排班，走教練手建時段即可，
//   不需要第二套規則跟營業時間互相打架。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/closed-dates', requireAdminAuth, AM, async (req, res) => {
  const venueId = String(req.query.venueId || '').trim();
  const from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : null;
  const to = DATE_RE.test(String(req.query.to || '')) ? req.query.to : null;
  try {
    const r = await pool.query(
      `SELECT c.id, c.venue_id, v.name AS venue_name,
              to_char(c.closed_date,'YYYY-MM-DD') AS closed_date, c.reason, c.created_at
         FROM venue_closed_dates c JOIN venues v ON v.id = c.venue_id
        WHERE ($1 = '' OR c.venue_id = $1)
          AND ($2::date IS NULL OR c.closed_date >= $2::date)
          AND ($3::date IS NULL OR c.closed_date <= $3::date)
        ORDER BY c.closed_date, c.venue_id`,
      [venueId, from, to]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/venue-hours closed-dates list]', err.message);
    res.status(500).json({ error: '讀取休館日期失敗' });
  }
});

router.post('/closed-dates', requireAdminAuth, AM, async (req, res) => {
  const venueId = String(req.body?.venue_id || '').trim();
  const closedDate = String(req.body?.closed_date || '').trim();
  const reason = String(req.body?.reason || '').trim() || null;
  if (!venueId) return res.status(400).json({ error: '請選擇場館', code: 'INPUT_INVALID' });
  if (!DATE_RE.test(closedDate)) return res.status(400).json({ error: '日期格式須為 YYYY-MM-DD', code: 'INPUT_INVALID' });
  try {
    const v = await pool.query(`SELECT id FROM venues WHERE id = $1`, [venueId]);
    if (!v.rowCount) return res.status(404).json({ error: '找不到此場館' });
    // 已經有預約的時段不會被休館設定影響（產生器只管未來要不要「產生」，
    // 不會刪既有時段）。這裡明確告知櫃檯當天已有幾筆預約，避免誤以為會自動取消。
    const booked = await pool.query(
      `SELECT count(*)::int AS n FROM course_sessions cs
         JOIN course_periods cp ON cp.id = cs.course_period_id
        WHERE cp.venue_id = $1
          AND cs.status = 'confirmed'
          AND (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date = $2::date`,
      [venueId, closedDate]
    );
    const client = await pool.connect();
    let removedSlots = 0;
    let r;
    try {
      await client.query('BEGIN');
      r = await client.query(
        `INSERT INTO venue_closed_dates (venue_id, closed_date, reason, created_by)
         VALUES ($1,$2::date,$3,$4)
         ON CONFLICT (venue_id, closed_date) DO UPDATE SET reason = EXCLUDED.reason
         RETURNING id, venue_id, to_char(closed_date,'YYYY-MM-DD') AS closed_date, reason`,
        [venueId, closedDate, reason, req.adminUser?.username || req.adminUser?.sub || null]
      );
      const del = await client.query(
        `DELETE FROM coach_availability_slots cas
          WHERE cas.generated_by = 'auto'
            AND cas.status = 'available'
            AND cas.venue_id IS NULL
            AND cas.booked_session_id IS NULL
            AND (cas.start_at AT TIME ZONE 'Asia/Taipei')::date = $1::date
            AND EXISTS (SELECT 1 FROM coach_venues cv
                         WHERE cv.coach_id = cas.coach_id AND cv.venue_id = $2)
            AND NOT EXISTS (
              SELECT 1 FROM coach_venues cv2
               JOIN venues v2 ON v2.id = cv2.venue_id AND v2.is_active
               WHERE cv2.coach_id = cas.coach_id
                 AND NOT EXISTS (SELECT 1 FROM venue_closed_dates c2
                                  WHERE c2.venue_id = cv2.venue_id AND c2.closed_date = $1::date))
          RETURNING cas.id`,
        [closedDate, venueId]
      );
      removedSlots = del.rowCount;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }    const notes = [];
    if (removedSlots) notes.push(`已移除該日 ${removedSlots} 個尚未被預約的自動時段。`);
    if (booked.rows[0].n) notes.push(`該日已有 ${booked.rows[0].n} 筆預約，休館設定不會自動取消，請另行處理。`);
    res.json({
      ok: true, ...r.rows[0],
      existing_bookings: booked.rows[0].n,
      removed_auto_slots: removedSlots,
      note: notes.length ? notes.join(' ') : null,
    });
  } catch (err) {
    console.error('[admin/venue-hours closed-dates create]', err.message);
    res.status(500).json({ error: '設定休館日期失敗' });
  }
});

router.delete('/closed-dates/:id', requireAdminAuth, AM, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM venue_closed_dates WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: '找不到此休館設定' });
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    console.error('[admin/venue-hours closed-dates delete]', err.message);
    res.status(500).json({ error: '刪除休館日期失敗' });
  }
});

module.exports = router;
module.exports.validateRow = validateRow;