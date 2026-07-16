/**
 * Task #60：學員自助報到（LIFF 端）
 *  POST /api/checkins/self  { course_period_id, student_ids[] }（U13 免預約自助簽到）
 *  POST /api/checkins  { sessionId, studentId }
 *    - 寫入 checkin_records（UNIQUE: session+student → 重複時回傳既有 row，不報錯）
 *    - 廣播 admin WS 事件 'checkin:created'
 *    - 需要家長 JWT；驗證 student 屬於 req 的 parent
 *    - 課程須為 confirmed/completed 才可簽到（與教練端 POST /sessions/:id/checkins 一致；
 *      pending_group_confirm 等狀態回 409 SESSION_NOT_CHECKINABLE）
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const { broadcastAdminEvent } = require('../services/websocket');
const { getFeatureFlag, flagAllowsPhone } = require('../services/featureFlags');
const { syncStoredUsage } = require('../services/usageSync');

/**
 * U13 免預約自助簽到 —— checkin_mode='self' 的課程期，家長不需先排課：
 * 按「今日上課簽到」→ 同交易「即時補建一堂當日課堂（created_via='self_checkin'、
 * status='completed'）＋勾選學員的簽到紀錄」。因為是真實 course_session，
 * 堂數計算／教練上課紀錄／學習歷程／報表全部沿用既有資料路徑，零分岔。
 *
 * 防呆層次（server 為唯一真相，前端顯示過期只會收到明確 409）：
 *  1. 同一期每日限一次：uq_sessions_self_checkin_daily partial unique index 硬保證，
 *     雙擊／斷網重送／多裝置並發都不可能扣兩堂（撞鍵回 409 ALREADY_CHECKED_IN_TODAY）。
 *  2. 堂數上限：非取消課堂數 >= total_sessions → 409 NO_SESSIONS_LEFT（與 slots 容量同款）。
 *  3. advisory lock 序列化同期並發，容量檢查與建堂之間無競態。
 *  4. 共班一堂＝一個 session，多位學員掛同一堂的多筆 checkin（不會一堂扣多堂）。
 *  5. 過渡保護（預約制→自助切換期，既有已排課堂/既有簽到照舊有效）：
 *     a. 同一期「今天」已有任何簽到（含預約課堂由家長/教練/櫃檯簽）→ 409，杜絕跨模式一天雙扣；
 *     b. 今天已排、未簽到的預約課堂 → 直接簽進該堂（reused_booked_session=true，不另建），
 *        預約課堂不會變成佔堂數的幽靈課堂。
 * 家長不可自行撤銷（營運規則）；誤點由櫃檯走 DELETE /api/admin/checkins/self-sessions/:id。
 */
router.post('/self', requireParent, async (req, res) => {
  const periodId = String(req.body?.course_period_id || '').trim();
  const studentIds = Array.isArray(req.body?.student_ids)
    ? [...new Set(req.body.student_ids.map((s) => String(s || '').trim()).filter(Boolean))]
    : [];
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(periodId)) return res.status(400).json({ error: 'course_period_id required', code: 'PERIOD_REQUIRED' });
  if (!studentIds.length || studentIds.some((s) => !UUID_RE.test(s))) {
    return res.status(400).json({ error: '請選擇至少一位今日上課的學員', code: 'STUDENTS_REQUIRED' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 同期並發簽到序列化（容量檢查 → 建堂之間無競態）
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`self-checkin:${periodId}`]);

    const pr = await client.query(
      `SELECT cp.id, cp.status::text AS status, cp.checkin_mode, cp.total_sessions,
              cp.coach_id, cp.venue_id, cp.course_type,
              cp.admin_enrollment_id, cp.group_order_id, cp.enrollment_batch_id, cp.period_number,
              (cp.expires_at >= (NOW() AT TIME ZONE 'Asia/Taipei')::date) AS not_expired,
              c.name AS coach_name, av.name AS venue_name
         FROM course_periods cp
         LEFT JOIN coaches c ON c.id = cp.coach_id
         LEFT JOIN admin_venues av ON av.id = cp.venue_id
        WHERE cp.id = $1
        FOR UPDATE OF cp`,
      [periodId]
    );
    if (!pr.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到課程期', code: 'PERIOD_NOT_FOUND' });
    }
    const period = pr.rows[0];
    if (period.checkin_mode !== 'self') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此課程為預約制，請先預約課程再簽到', code: 'SELF_CHECKIN_NOT_ENABLED' });
    }
    if (period.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此課程期目前非進行中，無法簽到', code: 'PERIOD_NOT_ACTIVE' });
    }
    if (!period.not_expired) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此課程期已到期，請洽櫃檯', code: 'PERIOD_EXPIRED' });
    }

    // 請求中的學員必須屬於本家長且在本期 active 名單中（防越權／防誤選）。
    // v2 對共享課期的實際 attendance 會由後端重新取得完整 active roster，不能
    // 信任某一位家長送來的清單來決定其他家庭是否扣課。
    const own = await client.query(
      `SELECT s.id, s.name
         FROM students s
         JOIN course_period_enrollments cpe
           ON cpe.course_period_id = $2 AND cpe.student_id = s.id AND cpe.status = 'active'
        WHERE s.id = ANY($1::uuid[]) AND s.parent_id = $3`,
      [studentIds, periodId, req.parent.id]
    );
    if (own.rowCount !== studentIds.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '所選學員不在此課程名單中', code: 'STUDENT_NOT_IN_PERIOD' });
    }

    const sharedFlag = await getFeatureFlag('SHARED_CHECKIN_USAGE_V2', client);
    const useSharedUsageV2 = flagAllowsPhone(sharedFlag, req.parent.phone);
    const activeParticipants = useSharedUsageV2
      ? await client.query(
        `SELECT s.id, s.name, s.parent_id
           FROM course_period_enrollments cpe
           JOIN students s ON s.id = cpe.student_id
          WHERE cpe.course_period_id = $1
            AND cpe.status = 'active'
            AND COALESCE(s.is_active, TRUE) = TRUE
          ORDER BY s.id
          FOR SHARE OF cpe, s`,
        [periodId]
      )
      : own;
    if (!activeParticipants.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此課程目前沒有有效學員', code: 'NO_ACTIVE_PARTICIPANTS' });
    }

    // 已成功建立的自助課堂是 retry 的冪等結果。advisory lock 讓雙擊與多裝置
    // 並發在這裡序列化；第二個請求回同一 session，而不是再扣一堂或模糊 409。
    const existingSelf = await client.query(
      `SELECT id, scheduled_at
         FROM course_sessions
        WHERE course_period_id = $1
          AND created_via = 'self_checkin'
          AND self_checkin_date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
        ORDER BY created_at
        LIMIT 1`,
      [periodId]
    );
    if (existingSelf.rowCount) {
      const existing = existingSelf.rows[0];
      const usedRes = await client.query(
        `SELECT COUNT(DISTINCT cr.course_session_id)::int AS n
           FROM checkin_records cr
           JOIN course_sessions cs ON cs.id = cr.course_session_id
          WHERE cs.course_period_id = $1
            AND cs.status::text NOT LIKE 'cancelled%'
            AND cr.attendance_status = 'ATTENDED'`,
        [periodId]
      );
      const used = Number(usedRes.rows[0]?.n || 0);
      await syncStoredUsage(client, period, used);
      await client.query('COMMIT');
      return res.json({
        ok: true,
        idempotent: true,
        session_id: existing.id,
        reused_booked_session: false,
        checked_in_students: own.rows.map((s) => s.name),
        total_sessions: period.total_sessions,
        used_sessions: used,
        remaining_sessions: Math.max(0, period.total_sessions - used),
      });
    }

    // 過渡保護 1（預約制→自助切換期）：同一期「今天」已有任何簽到——不論是
    // 預約課堂的逐堂簽到（家長/教練/櫃檯）或自助簽到——一律擋。每日一次的
    // unique index 只涵蓋自助建立的課堂，這裡把跨模式的「一天雙扣」也關掉。
    const todayCheckedIn = await client.query(
      `SELECT 1 FROM checkin_records cr
         JOIN course_sessions cs ON cs.id = cr.course_session_id
        WHERE cs.course_period_id = $1
          AND cs.status NOT IN ('cancelled_normal','cancelled_penalty')
          AND cr.attendance_status = 'ATTENDED'
          AND (cr.checked_in_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
        LIMIT 1`,
      [periodId]
    );
    if (todayCheckedIn.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: '今日此課程已有簽到紀錄（每日限一堂）；如需更正請洽櫃檯',
        code: 'ALREADY_CHECKED_IN_TODAY',
      });
    }

    // 過渡保護 2：今天已排、尚未簽到的預約課堂 → 直接簽進「那一堂」，不另建課堂。
    // 否則預約那堂會變成佔用堂數的幽靈課堂（家長看似扣了兩堂）。
    const todayBooked = await client.query(
      `SELECT id, scheduled_at FROM course_sessions
        WHERE course_period_id = $1
          AND status IN ('confirmed','completed')
          AND (scheduled_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
        ORDER BY scheduled_at
        LIMIT 1`,
      [periodId]
    );
    let sessionRow = null;
    let reusedBookedSession = false;
    if (todayBooked.rowCount) {
      sessionRow = todayBooked.rows[0];
      reusedBookedSession = true;
      await client.query(
        `UPDATE course_sessions
            SET status = 'completed', completed_at = COALESCE(completed_at, NOW()),
                session_deducted = TRUE, updated_at = NOW()
          WHERE id = $1`,
        [sessionRow.id]
      );
    } else {
      // 堂數上限：非取消課堂（含預約制已排未上）達購買堂數即擋。
      // 只有「需要新建課堂」時才檢查——簽進既有課堂不會增加課堂數。
      const cap = await client.query(
        `SELECT COUNT(*)::int AS n FROM course_sessions
          WHERE course_period_id = $1 AND status NOT IN ('cancelled_normal','cancelled_penalty')`,
        [periodId]
      );
      if (cap.rows[0].n >= period.total_sessions) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '本期堂數已用完，如需續課請重新報名', code: 'NO_SESSIONS_LEFT' });
      }

      // 建當日課堂；同一期同一天第二次會撞 uq_sessions_self_checkin_daily → 409
      try {
        const ins = await client.query(
          `INSERT INTO course_sessions
             (course_period_id, coach_id, scheduled_at, duration_minutes, status,
              completed_at, created_via, self_checkin_date, session_deducted)
           VALUES ($1, $2, NOW(), 60, 'completed', NOW(), 'self_checkin',
                   (NOW() AT TIME ZONE 'Asia/Taipei')::date, TRUE)
           RETURNING id, scheduled_at`,
          [periodId, period.coach_id]
        );
        sessionRow = ins.rows[0];
      } catch (e) {
        if (e.code === '23505') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: '今日已完成簽到（同一課程每日限簽一次）；如需更正請洽櫃檯',
            code: 'ALREADY_CHECKED_IN_TODAY',
          });
        }
        throw e;
      }
    }

    for (const s of activeParticipants.rows) {
      await client.query(
        `INSERT INTO checkin_records
           (course_session_id, student_id, checked_in_by_student_id,
            checked_in_source, checked_in_by_parent_id)
         VALUES ($1, $2, $2, 'parent', $3)
         ON CONFLICT (course_session_id, student_id) DO NOTHING`,
        [sessionRow.id, s.id, req.parent.id]
      );
    }

    // 最新已用堂數（DISTINCT session，與 /courses/mine 同一真相）供前端即時更新
    const usedRes = await client.query(
      `SELECT COUNT(DISTINCT cr.course_session_id)::int AS n
         FROM checkin_records cr
         JOIN course_sessions cs ON cs.id = cr.course_session_id
        WHERE cs.course_period_id = $1
          AND cs.status::text NOT LIKE 'cancelled%'
          AND cr.attendance_status = 'ATTENDED'`,
      [periodId]
    );

    const used = usedRes.rows[0].n;
    await syncStoredUsage(client, period, used);
    await client.query('COMMIT');
    for (const s of activeParticipants.rows) {
      try {
        broadcastAdminEvent('checkin:created', {
          // 合成唯一 key：缺 checkin_id 時 CheckinPage 去重會把第 2 位起的事件誤吞
          checkin_id: `${sessionRow.id}:${s.id}`,
          at: sessionRow.scheduled_at instanceof Date ? sessionRow.scheduled_at.toISOString() : String(sessionRow.scheduled_at),
          session_id: sessionRow.id,
          period_id: periodId,
          venue_id: period.venue_id,
          venue_name: period.venue_name || period.venue_id,
          course_type: Number(period.course_type) || null,
          coach: period.coach_name || '',
          student: s.name || '',
          source: 'parent_self',
        });
      } catch (e) { console.warn('[checkins/self] broadcast skipped:', e?.message); }
    }

    res.status(201).json({
      ok: true,
      idempotent: false,
      session_id: sessionRow.id,
      reused_booked_session: reusedBookedSession, // true＝簽進今天既有的預約課堂（未另建）
      // 不把其他家庭的姓名透露給操作家長；後端仍已替完整 active roster 建 attendance。
      checked_in_students: own.rows.map((s) => s.name),
      attendance_count: activeParticipants.rowCount,
      total_sessions: period.total_sessions,
      used_sessions: used,
      remaining_sessions: Math.max(0, period.total_sessions - used),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[checkins/self POST]', err);
    res.status(500).json({ error: '簽到失敗，請稍後再試或洽櫃檯', code: 'SELF_CHECKIN_FAILED' });
  } finally {
    client.release();
  }
});

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
      `SELECT cs.id AS session_id, cs.status::text AS session_status,
              cp.id AS period_id, cp.venue_id, cp.course_type, cp.coach_id,
              cp.total_sessions, cp.admin_enrollment_id, cp.group_order_id,
              cp.enrollment_batch_id, cp.period_number,
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
              )
        FOR UPDATE OF cp`,
      [sessionId, studentId]
    );
    // FOR UPDATE OF cp：與手動扣課／自助簽到共用 period 列鎖，讓「計數已出席堂數 →
    // 寫回 used_sessions 鏡射」序列化，避免並發時以舊計數覆寫（低估 1 堂）。
    if (!ctx.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '該學員未在此課程名單中' });
    }

    const sessionStatus = ctx.rows[0].session_status;
    if (!['confirmed', 'completed'].includes(sessionStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: sessionStatus === 'pending_group_confirm'
          ? '此課程仍在等待同組家長確認，暫不可簽到'
          : '此課程狀態不可簽到',
        code: 'SESSION_NOT_CHECKINABLE',
      });
    }

    const sharedFlag = await getFeatureFlag('SHARED_CHECKIN_USAGE_V2', client);
    if (flagAllowsPhone(sharedFlag, req.parent.phone)) {
      await client.query(
        `INSERT INTO checkin_records
           (course_session_id, student_id, checked_in_by_student_id,
            checked_in_source, checked_in_by_parent_id)
         SELECT $1, cpe.student_id, cpe.student_id, 'parent', $2
           FROM course_period_enrollments cpe
           JOIN students s ON s.id = cpe.student_id
          WHERE cpe.course_period_id = $3 AND cpe.status = 'active'
            AND COALESCE(s.is_active, TRUE) = TRUE
         ON CONFLICT (course_session_id, student_id) DO NOTHING`,
        [sessionId, req.parent.id, ctx.rows[0].period_id]
      );
    } else {
      await client.query(
        `INSERT INTO checkin_records
           (course_session_id, student_id, checked_in_by_student_id,
            checked_in_source, checked_in_by_parent_id)
         VALUES ($1, $2, $2, 'parent', $3)
         ON CONFLICT (course_session_id, student_id) DO NOTHING`,
        [sessionId, studentId, req.parent.id]
      );
    }
    const ins = await client.query(
      `SELECT id, checked_in_at, checked_in_source
         FROM checkin_records WHERE course_session_id = $1 AND student_id = $2`,
      [sessionId, studentId]
    );
    const usedRes = await client.query(
      `SELECT COUNT(DISTINCT cs.id)::int AS n
         FROM course_sessions cs JOIN checkin_records cr ON cr.course_session_id = cs.id
        WHERE cs.course_period_id = $1 AND cs.status::text NOT LIKE 'cancelled%'
          AND cr.attendance_status = 'ATTENDED'`,
      [ctx.rows[0].period_id]
    );
    await client.query(
      `UPDATE course_sessions SET session_deducted = TRUE, updated_at = NOW() WHERE id = $1`,
      [sessionId]
    );
    await syncStoredUsage(client, { ...ctx.rows[0], id: ctx.rows[0].period_id }, Number(usedRes.rows[0]?.n || 0));
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
