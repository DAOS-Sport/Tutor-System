// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔凍結範圍：家長選槽 POST /:id/book 一律即時 confirmed（不得加回同組確認分流）。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
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
const { detectConflict, createSlot, batchCreateSlots, bookSlot1v1, cancelSession } = require('../services/slots');
const { canSelfCancel, cancelRejectMessage } = require('../services/bookingPolicy');
const { requireCoach, requireCoachOwner } = require('../middlewares/coachAuth');
const { requireParent } = require('../middlewares/parentAuth');
const { addCalendarDays, taipeiToday, taipeiWeekStart } = require('../utils/dateTime');
// 模組 1 旗標：同時守住 cron 產生、家長查詢可見性、預約 auto slot 三個入口。
const { isInSlotSupplyScope, isSlotSupplyEnabled } = require('../config/slotSupplyFlags');

function todayInTaipei() {
  return taipeiToday();
}
function parseTaipeiDateBoundary(value) {
  const v = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00+08:00`);
  return new Date(v);
}
function ymdInTaipei(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
function weekdayInTaipei(date) {
  return new Date(`${ymdInTaipei(date)}T12:00:00+08:00`).getUTCDay();
}

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

// 教練端唯讀：自己所屬場館的營業時間 + 範圍內的特殊休館日。
//
// 為什麼要有這支：時段是依營業時間自動長出來的，教練在排課總表上只看得到
// 「有哪些格」，看不到「依據是什麼」。整週空白時無從判斷是自己關光了、
// 還是場館根本沒設營業時間。後台那支 /api/admin/venue-hours 限 admin/manager，
// 教練不該也不需要拿到寫入權，所以另開一個唯讀端點。
router.get('/coach/:coachId/venue-hours', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  const { coachId } = req.params;
  const { from, to } = req.query;
  try {
    const r = await pool.query(
      `SELECT cv.venue_id, v.name AS venue_name,
              h.weekday, h.open_time, h.close_time, h.slot_minutes
         FROM coach_venues cv
         JOIN venues v ON v.id = cv.venue_id AND v.is_active
         LEFT JOIN venue_business_hours h ON h.venue_id = cv.venue_id AND h.is_active
        WHERE cv.coach_id = $1
        ORDER BY v.name, h.weekday`,
      [coachId]
    );
    const closed = await pool.query(
      `SELECT c.venue_id, to_char(c.closed_date,'YYYY-MM-DD') AS closed_date, c.reason
         FROM venue_closed_dates c
         JOIN coach_venues cv ON cv.venue_id = c.venue_id AND cv.coach_id = $1
        WHERE ($2::date IS NULL OR c.closed_date >= $2::date)
          AND ($3::date IS NULL OR c.closed_date <= $3::date)
        ORDER BY c.closed_date`,
      [coachId, from || null, to || null]
    );

    const byVenue = new Map();
    for (const row of r.rows) {
      if (!byVenue.has(row.venue_id)) {
        byVenue.set(row.venue_id, {
          venue_id: row.venue_id, venue_name: row.venue_name, hours: [], closed_dates: [],
        });
      }
      // LEFT JOIN：場館尚未設定營業時間時 weekday 為 NULL，不能當成一筆時間。
      if (row.weekday !== null && row.weekday !== undefined) {
        byVenue.get(row.venue_id).hours.push({
          weekday: Number(row.weekday),
          open_time: String(row.open_time).slice(0, 5),
          close_time: String(row.close_time).slice(0, 5),
          slot_minutes: Number(row.slot_minutes) || 60,
        });
      }
    }
    for (const c of closed.rows) {
      const v = byVenue.get(c.venue_id);
      if (v) v.closed_dates.push({ closed_date: c.closed_date, reason: c.reason || null });
    }
    res.json({ venues: [...byVenue.values()] });
  } catch (err) {
    console.error('[slots coach venue-hours]', err.message);
    res.status(500).json({ error: '營業時間載入失敗' });
  }
});

// 取教練槽位 + 已 booked 的 session 細節（學員姓名）
router.get('/coach/:coachId', requireCoach, requireCoachOwner('coachId'), async (req, res) => {
  const { coachId } = req.params;
  const { from, to } = req.query;
  const fromDate = parseTaipeiDateBoundary(from || taipeiWeekStart());
  const toDate = parseTaipeiDateBoundary(to || addCalendarDays(from || taipeiWeekStart(), 7));
  try {
    const r = await pool.query(
      // 039：auto 產生的時段 venue_id 為 NULL（跨場館共用）。這裡若用 INNER JOIN
      // venues，整批 NULL venue 的列會被濾掉 → 教練在排課總表上看不見自動時段，
      // 也就永遠無法關班。家長端（下方 availableForPeriod）早已改成 LEFT JOIN，
      // 教練端必須同步，否則「預設開放、教練關班」的模型在教練側根本無從操作。
      `SELECT cas.id, cas.coach_id, cas.venue_id, v.name AS venue_name,
              (cas.generated_by = 'auto') AS is_auto,
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
       LEFT JOIN venues v ON v.id = cas.venue_id
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
  const fromDate = parseTaipeiDateBoundary(from);
  const toDate = parseTaipeiDateBoundary(to);
  const slots = [];
  for (let d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!weekdays.includes(weekdayInTaipei(d))) continue;
    const ymd = ymdInTaipei(d);
    for (const t of times) {
      const [hh, mm = 0] = t.split(':').map(Number);
      const startAt = new Date(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);
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

// ── 家長端：取消自己的預約（模組 1）────────────────────────────────
//   DELETE /api/slots/booking/:sessionId
//   政策（使用者決策 2026-08-03）：開課前 ≥24h 可自行取消；<24h 不可取消，
//   家長不出席即可，逾時未簽到由 cron 自動復原容量（見 bookingPolicy.js）。
//
//   服務層 cancelSession() 早就存在但從未有任何端點呼叫它（只有 e2e 直接呼叫函式），
//   所以「家長自助取消」這個功能實際上從未上線。這裡把它接起來。
router.delete('/booking/:sessionId', requireParent, async (req, res) => {
  const sessionId = String(req.params.sessionId || '');
  try {
    // 只允許取消「自己名下在籍學員」的預約，且必須是未取消、未完成的堂
    const own = await pool.query(
      `SELECT cs.id, cs.scheduled_at, cs.status
         FROM course_sessions cs
         JOIN course_periods cp ON cp.id = cs.course_period_id
         JOIN course_period_enrollments cpe ON cpe.course_period_id = cp.id AND cpe.status = 'active'
         JOIN students s ON s.id = cpe.student_id
        WHERE cs.id = $1 AND s.parent_id = $2
        LIMIT 1`,
      [sessionId, req.parent.id]
    );
    if (!own.rowCount) return res.status(404).json({ error: '找不到此預約', code: 'SESSION_NOT_FOUND' });
    const session = own.rows[0];
    if (session.status !== 'confirmed') {
      return res.status(409).json({ error: '此堂課目前無法取消', code: 'SESSION_NOT_CANCELLABLE' });
    }
    const verdict = canSelfCancel(session.scheduled_at);
    if (!verdict.allowed) {
      return res.status(409).json({
        // 只有自動復原真的會跑時，才對家長承諾「時間過後會自動回復」。
        error: cancelRejectMessage(verdict.reason, verdict.hoursUntil, {
          autoRestoreEnabled: isSlotSupplyEnabled(),
        }),
        code: `CANCEL_${verdict.reason}`,
        hours_until: Math.max(0, Math.round(verdict.hoursUntil * 10) / 10),
      });
    }
    // 真正的裁判在 cancelSession 的交易內：上面的 status 檢查用的是另一條連線、
    // 又在交易外，兩個並發請求會同時通過。服務層以 `WHERE status='confirmed'`
    // 讓資料庫決定誰贏，這裡只負責把結果翻成人話。
    const result = await cancelSession(sessionId, 'normal');
    if (!result.cancelled) {
      if (result.reason === 'ALREADY_CHECKED_IN') {
        return res.status(409).json({
          error: '這堂課已完成簽到，無法取消。如需處理請洽櫃檯。',
          code: 'CANCEL_ALREADY_CHECKED_IN',
        });
      }
      if (result.reason === 'SESSION_NOT_FOUND') {
        return res.status(404).json({ error: '找不到此預約', code: 'SESSION_NOT_FOUND' });
      }
      // NOT_CONFIRMED：多半是另一個分頁剛剛取消掉了，對使用者而言結果一樣。
      return res.status(409).json({ error: '此堂課目前無法取消', code: 'SESSION_NOT_CANCELLABLE' });
    }
    res.json({ ok: true, session_id: sessionId, cancel_type: 'normal' });
  } catch (err) {
    console.error('[slots cancel-booking]', err.message);
    res.status(500).json({ error: '取消預約失敗' });
  }
});

router.post('/preview-conflict', requireCoach, ensureBodyOwner, async (req, res) => {
  const { coach_id, start_at, duration_minutes = 60 } = req.body || {};
  if (!coach_id || !start_at) return res.status(400).json({ error: 'coach_id / start_at 必填' });
  const conflicts = await detectConflict(coach_id, start_at, duration_minutes);
  res.json({ has_conflict: conflicts.length > 0, conflicts });
});

// ── 家長端：查詢某課程期可選槽位 ─────────────────────────────────────
router.get('/period/:coursePeriodId', requireParent, async (req, res) => {
  const { coursePeriodId } = req.params;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(coursePeriodId || '')) {
    return res.status(404).json({ error: '課程期不存在' });
  }

  const fromDate = req.query.from ? parseTaipeiDateBoundary(req.query.from) : parseTaipeiDateBoundary(todayInTaipei());
  const toDate = req.query.to
    ? parseTaipeiDateBoundary(req.query.to)
    : parseTaipeiDateBoundary(addCalendarDays(ymdInTaipei(fromDate), 30));
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'from/to 日期格式錯誤' });
  }

  try {
    const cpRes = await pool.query(
      `SELECT cp.id, cp.coach_id, co.name AS coach_name, cp.venue_id, v.name AS venue_name,
              cp.course_type, cp.status, cp.total_sessions,
              COUNT(cs.id) FILTER (WHERE cs.status::text NOT LIKE 'cancelled%')::int AS booked_sessions
         FROM course_periods cp
         JOIN coaches co ON co.id = cp.coach_id
         JOIN venues v ON v.id = cp.venue_id
         LEFT JOIN course_sessions cs ON cs.course_period_id = cp.id
        WHERE cp.id = $1
        GROUP BY cp.id, co.name, v.name`,
      [coursePeriodId]
    );
    if (!cpRes.rowCount) return res.status(404).json({ error: '課程期不存在' });
    const period = cpRes.rows[0];

    const own = await pool.query(
      `SELECT 1 FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
        WHERE cpe.course_period_id = $1
          AND s.parent_id = $2
          AND cpe.status = 'active'
        LIMIT 1`,
      [coursePeriodId, req.parent.id]
    );
    if (!own.rowCount) return res.status(403).json({ error: '無權檢視此課程期' });
    if (period.status !== 'active') {
      return res.json({ period, sessions_left: 0, slots: [] });
    }

    const slots = await pool.query(
      // 039：venue_id 為 NULL＝自動產生、尚未認領場館的時段，對本期同樣可選。
      // JOIN 必須是 LEFT，否則 NULL venue 的列會被整批濾掉（回傳空清單）。
      // 旗標守門（模組 1 規格：不得只用 cron 開關）：功能關閉或不在 canary 範圍時，
      // $5=false，NULL venue 的自動時段對家長完全不可見，等同未上線前的行為。
      // is_auto 必須由後端明確給出布林值：前端曾用 `is_auto !== false` 判斷，
      // 而後端當時根本沒回這個欄位 → undefined !== false 恆真 → 連教練手建的時段
      // 也被首次提示攔下。這裡回真正的布林，前端改用嚴格 === true。
      `SELECT cas.id, cas.coach_id, COALESCE(cas.venue_id, $2) AS venue_id,
              COALESCE(v.name, pv.name) AS venue_name,
              (cas.generated_by = 'auto') AS is_auto,
              cas.start_at, cas.duration_minutes, cas.status
         FROM coach_availability_slots cas
         LEFT JOIN venues v  ON v.id  = cas.venue_id
         LEFT JOIN venues pv ON pv.id = $2
        WHERE cas.coach_id = $1
          AND ((cas.venue_id IS NULL AND $5::boolean) OR cas.venue_id = $2)
          AND cas.status = 'available'
          AND cas.start_at >= $3
          AND cas.start_at < $4
          -- 下界 $3 是「台北今天 00:00」，不是現在。少了這條，今天稍早已經過去的
          -- 時段仍會列在可選清單裡；逾時未簽到自動復原又會把過去的槽位改回
          -- available，等於固定會有一批「約得到的過去時間」。
          AND cas.start_at > NOW()
        ORDER BY cas.start_at
        LIMIT 120`,
      [period.coach_id, period.venue_id, fromDate.toISOString(), toDate.toISOString(),
        isInSlotSupplyScope({ coachId: period.coach_id, venueId: period.venue_id })]
    );

    // 首次預約提示（模組 1）：每個課期跳一次「請先與教練確認時間再預約」。
    // 放在 course_period_enrollments 而非 parents —— 同一位家長的不同課期各提示一次。
    // 這裡只回狀態，實際確認由 POST /period/:id/ack-notice 寫入。
    const ack = await pool.query(
      `SELECT bool_or(cpe.booking_notice_ack_at IS NOT NULL) AS acked
         FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
        WHERE cpe.course_period_id = $1 AND s.parent_id = $2 AND cpe.status = 'active'`,
      [coursePeriodId, req.parent.id]
    );

    res.json({
      period,
      sessions_left: Math.max(0, Number(period.total_sessions) - Number(period.booked_sessions || 0)),
      slots: slots.rows,
      needs_booking_notice: ack.rows[0]?.acked !== true,
      booking_notice_text: '請先與教練確認時間，再進行預約。',
    });
  } catch (err) {
    console.error('[slots period]', err);
    res.status(500).json({ error: '可選時段載入失敗' });
  }
});

// ── 家長端：確認已讀「請先與教練確認時間」提示（模組 1）─────────────
//   POST /api/slots/period/:coursePeriodId/ack-notice
//   每個課期只需確認一次；重複呼叫冪等（COALESCE 保留第一次的時間戳）。
router.post('/period/:coursePeriodId/ack-notice', requireParent, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE course_period_enrollments cpe
          SET booking_notice_ack_at = COALESCE(cpe.booking_notice_ack_at, NOW())
         FROM students s
        WHERE s.id = cpe.student_id
          AND cpe.course_period_id = $1
          AND s.parent_id = $2
          AND cpe.status = 'active'
        RETURNING cpe.id`,
      [req.params.coursePeriodId, req.parent.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: '找不到此課程期', code: 'PERIOD_NOT_FOUND' });
    res.json({ ok: true, acked: true });
  } catch (err) {
    console.error('[slots ack-notice]', err.message);
    res.status(500).json({ error: '確認失敗' });
  }
});

// ── 家長端：選槽建立 session（架構 v7 §9.2「課程開通後選擇上課時間」）─────────
//   POST /api/slots/:id/book   body { course_period_id }
//   :id = coach_availability_slots.id（要預約的可用時段）
//
//   只新增此家長路由，完全不更動上方教練端路由。流程：
//   1) 鎖該教練（與教練開槽用同一把 advisory lock，序列化避免雙訂）
//   2) 驗證家長確實擁有該 course_period（透過 course_period_enrollments→students.parent_id）
//   3) 驗證 period 為 active、未超過已購堂數、slot 與 period 的教練/場館一致
//   4) 一律 bookSlot1v1 即時 confirmed（政策 2026-07：團報/共班預約不再等待
//      同組確認；任一家長預約即整組成立）
//   注意：選槽「不」異動 used_sessions——全系統堂數以 checkin_records 為準，
//   used_sessions 無任何 +1 處，動它會破壞既有計數。
router.post('/:id/book', requireParent, async (req, res) => {
  const slotId = req.params.id;
  const coursePeriodId = req.body?.course_period_id ? String(req.body.course_period_id) : '';
  if (!coursePeriodId) return res.status(400).json({ error: 'course_period_id 必填' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) 取槽位（拿 coach_id/venue_id 供上鎖與一致性檢查）
    const slotRes = await client.query(
      `SELECT id, coach_id, venue_id, status, start_at FROM coach_availability_slots WHERE id = $1`,
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
    // 039：自動產生的時段 venue_id 為 NULL（語意＝「這位教練這個時間有空」，尚未認領場館），
    // 對任何該教練的課程期都成立，預約當下才由 bookSlot1v1 寫入本期場館。
    // 教練手建的時段仍帶 venue_id，維持原本的嚴格比對。
    const venueMismatch = slot.venue_id !== null && String(slot.venue_id) !== String(cp.venue_id);
    if (slot.coach_id !== cp.coach_id || venueMismatch) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此時段與課程期的教練或場館不符', code: 'SLOT_MISMATCH' });
    }
    // 旗標守門（第三個入口）：功能關閉時，即使家長拿到舊的 slot id 直接打 API，
    // 也不能預約自動產生的時段。教練手建的時段（venue_id 有值）不受影響。
    if (slot.venue_id === null && !isInSlotSupplyScope({ coachId: cp.coach_id, venueId: cp.venue_id })) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此時段目前無法預約，請洽櫃台', code: 'SLOT_SUPPLY_DISABLED' });
    }
    if (slot.status !== 'available') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此時段已被預約或不可選', code: 'SLOT_UNAVAILABLE' });
    }
    // 不得預約已經過去的時間。查詢端雖然也過濾了，但那是列表產生當下的判斷——
    // 家長把頁面開著十分鐘再送出、或直接拿舊的 slot id 打 API，都會繞過它。
    // 而且逾時未簽到的自動復原會把過去的槽位改回 available，這種列一直都會存在。
    if (new Date(slot.start_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此時段已經過了，請改選其他時間', code: 'SLOT_IN_PAST' });
    }
    // 容量：已排（未取消）堂數不得超過已購買 total_sessions
    const used = await client.query(
      `SELECT COUNT(*)::int AS n FROM course_sessions
        WHERE course_period_id = $1 AND status::text NOT LIKE 'cancelled%'`,
      [coursePeriodId]
    );
    if (used.rows[0].n >= cp.total_sessions) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '可預約堂數已用完', code: 'NO_SESSIONS_LEFT' });
    }

    // 5) 一律即時確認（政策變更）：團報/家庭共班不再走 pending_group_confirm
    //    「等待同組確認」流程——任一家長預約即代表整組成立，其他成員之後在
    //    上課記錄看到「已簽 · 簽到方姓名」。舊 pending 資料由 bootstrap 遷移轉正。
    const session = await bookSlot1v1(slotId, coursePeriodId, client);

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
