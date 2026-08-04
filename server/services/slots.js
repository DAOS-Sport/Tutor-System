// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔凍結範圍：bookSlot1v1 即時確認（不得復活 bookSlot1vN / pending_group_confirm 流程）。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
/**
 * 教練可用時段（coach_availability_slots）業務邏輯
 * 核心：衝突偵測在「教練新增槽位時」執行，而非學員預約時
 */
const { pool } = require('../models/db');
const { formatTaipeiDateTime } = require('../utils/dateTime');
// 只呼叫、不修改：usageSync.js 全檔屬簽到／扣課凍結範圍。
const { syncStoredUsage } = require('./usageSync');

/**
 * 衝突偵測（共用：可在任意 client / pool 上執行）
 * 同一教練，新槽位時間區間不可與任何 available/booked 槽位重疊（跨場館均計算）
 */
async function detectConflict(coachIdOrClient, startAtMaybe, durationMinutesMaybe, excludeSlotId = null) {
  // 支援兩種呼叫：detectConflict(coachId, startAt, dur)（舊）/ detectConflictOn(client, ...) 內部使用
  const db = pool;
  return _detectConflictOn(db, coachIdOrClient, startAtMaybe, durationMinutesMaybe, excludeSlotId);
}

async function _detectConflictOn(db, coachId, startAt, durationMinutes, excludeSlotId = null) {
  const res = await db.query(
    // 039：auto 時段 venue_id 為 NULL。這裡若用 INNER JOIN venues，那些列會被
    // 濾掉，衝突偵測就漏判——教練手建一個與自動時段重疊的槽位不會被擋下，
    // 同一教練同時段被重複佔用。上面註解寫的「跨場館均計算」要成立就必須 LEFT JOIN。
    `SELECT cas.id, cas.venue_id, cas.start_at, cas.duration_minutes,
            COALESCE(v.name, '全場館共用') AS venue_name
     FROM coach_availability_slots cas
     LEFT JOIN venues v ON cas.venue_id = v.id
     WHERE cas.coach_id = $1
       AND cas.status IN ('available', 'pending_group_confirm', 'booked')
       AND ($2::timestamptz < cas.start_at + (cas.duration_minutes || ' minutes')::interval)
       AND (($2::timestamptz + ($3 || ' minutes')::interval) > cas.start_at)
       ${excludeSlotId ? 'AND cas.id != $4' : ''}`,
    excludeSlotId ? [coachId, startAt, durationMinutes, excludeSlotId] : [coachId, startAt, durationMinutes]
  );
  return res.rows;
}

/**
 * 建立單一槽位（含並發保護）
 *
 * 並發保護：使用 transaction-scoped advisory lock with key = hashtext(coachId)
 * 確保「衝突檢查 + INSERT」對同一教練序列化執行，避免兩個並發請求都通過檢查、
 * 卻插入互相重疊的時段。Lock 在 COMMIT/ROLLBACK 時自動釋放。
 */
async function createSlot({ coachId, venueId, startAt, durationMinutes, notes }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(coachId)]);

    const conflicts = await _detectConflictOn(client, coachId, startAt, durationMinutes);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      throw new Error(`時段衝突：與 ${c.venue_name} ${formatTaipeiDateTime(c.start_at)}（台北時間）的課程重疊`);
    }
    const res = await client.query(
      `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status, notes)
       VALUES ($1, $2, $3, $4, 'available', $5) RETURNING *`,
      [coachId, venueId, startAt, durationMinutes || 60, notes]
    );
    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 批量建立槽位（跳過衝突，回傳建立結果統計）
 */
async function batchCreateSlots(slots) {
  let created = 0, skipped = 0, errors = [];
  for (const slot of slots) {
    try {
      await createSlot(slot);
      created++;
    } catch (err) {
      skipped++;
      // 統一錯誤格式：{ start_at, error } — 前端 BatchResultModal 直接消費
      errors.push({
        start_at: slot.startAt || slot.start_at || null,
        venue_id: slot.venueId || slot.venue_id || null,
        error: err.message,
      });
    }
  }
  return { created, skipped, errors };
}

/**
 * 學員選槽（1v1）：即時確認
 */
async function bookSlot1v1(slotId, coursePeriodId, client) {
  const db = client || pool;
  // 建立課程時段
  const sessionRes = await db.query(
    `INSERT INTO course_sessions (course_period_id, availability_slot_id, scheduled_at, duration_minutes, status, coach_id)
     SELECT $1, cas.id, cas.start_at, cas.duration_minutes, 'confirmed',
            (SELECT coach_id FROM course_periods WHERE id = $1)
     FROM coach_availability_slots cas WHERE cas.id = $2 AND cas.status = 'available'
     RETURNING *`,
    [coursePeriodId, slotId]
  );
  if (sessionRes.rows.length === 0) throw new Error('此時段已被預約或不存在');
  const session = sessionRes.rows[0];
  // 更新槽位狀態。039：自動產生的槽位 venue_id 為 NULL，於此認領本期場館；
  // 教練手建的槽位已有 venue_id，COALESCE 保證不被覆蓋。
  await db.query(
    `UPDATE coach_availability_slots
        SET status = 'booked', booked_session_id = $1,
            venue_id = COALESCE(venue_id, (SELECT venue_id FROM course_periods WHERE id = $3))
      WHERE id = $2`,
    [session.id, slotId, coursePeriodId]
  );
  return session;
}

// bookSlot1vN（1vN 暫鎖等待同組確認）已於政策變更時移除：團報預約不再需要
// 雙方同意，所有預約一律走 bookSlot1v1 即時確認。舊 pending_group_confirm 資料
// 由 bootstrap/coreSchema.js 的冪等遷移轉正；enum 值保留（PG 刪 enum 值成本高且無害）。

/**
 * 取消課程時段（學員自助 / 逾時未簽到自動復原），釋回槽位。
 *
 * 回傳 { cancelled: boolean }。cancelled=false 代表這筆早就不是 confirmed
 * （多半是另一個並發請求先取消了），呼叫端可以當成 no-op，不必當錯誤。
 *
 * 三件事以前是錯的：
 *
 * 1. 堂數：原本 `used_sessions = used_sessions - 1`。但 used_sessions 是
 *    checkin_records 的鏡射（見 services/usageSync.js 檔頭與 routes/slots.js
 *    的註解「選槽不異動 used_sessions」），全系統沒有任何 +1 處。拿一個從未被
 *    加過的計數去減，等於每取消一堂就讓該課期憑空多出一堂可用。
 *    改為以系統既有的權威查詢重算（DISTINCT 有 ATTENDED 且未取消的 session 數，
 *    與 routes/checkins.js 同一條），再交給 syncStoredUsage 寫回鏡射。
 *    重算是冪等的，還能順手修掉既有漂移。
 *
 * 2. 狀態守門：原本 UPDATE 沒有 WHERE status，路由的 status 檢查又在交易外、
 *    用另一條連線，兩個並發取消會各自成功、堂數退兩次。改為在 UPDATE 內
 *    以 `status = 'confirmed'` 守門並 RETURNING，讓資料庫決定誰贏。
 *
 * 3. 已簽到：簽到不會把 session 移出 confirmed，所以原本已簽到的課也能被取消，
 *    出席紀錄還留著、堂數卻被退掉。這裡直接拒絕，且是最後一道防線——
 *    路由那層另有對使用者友善的 409。
 *
 * 4. venue_id：auto 產生的槽位 venue_id 原本是 NULL（跨場館共用），預約時被
 *    COALESCE 認領成該課期的場館。釋回時若不還原，這個槽位就永久帶著場館，
 *    從此脫離 `venue_id IS NULL AND $flag` 那條旗標守門與 canary 範圍——
 *    kill switch 對它失效。只還原本來就是 auto 產生的那些。
 */
async function cancelSession(sessionId, cancelType) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 先鎖住 period 列，與簽到／手動扣課共用同一把鎖，讓「重算 → 寫回鏡射」序列化。
    const ctx = await client.query(
      `SELECT cp.id, cp.admin_enrollment_id, cp.group_order_id,
              cp.enrollment_batch_id, cp.period_number
         FROM course_sessions cs
         JOIN course_periods cp ON cp.id = cs.course_period_id
        WHERE cs.id = $1
        FOR UPDATE OF cp`,
      [sessionId]
    );
    if (!ctx.rowCount) {
      await client.query('ROLLBACK');
      return { cancelled: false, reason: 'SESSION_NOT_FOUND' };
    }

    // 已簽到就不准取消：出席是既成事實，抹掉它會讓堂數與出席紀錄互相矛盾。
    const attended = await client.query(
      `SELECT 1 FROM checkin_records
        WHERE course_session_id = $1 AND attendance_status = 'ATTENDED' LIMIT 1`,
      [sessionId]
    );
    if (attended.rowCount) {
      await client.query('ROLLBACK');
      return { cancelled: false, reason: 'ALREADY_CHECKED_IN' };
    }

    const upd = await client.query(
      `UPDATE course_sessions SET status = $1, cancelled_at = NOW()
        WHERE id = $2 AND status = 'confirmed'
        RETURNING id`,
      [`cancelled_${cancelType}`, sessionId]
    );
    if (!upd.rowCount) {
      // 已被別人取消（或狀態不是 confirmed）。不要繼續往下退堂數。
      await client.query('ROLLBACK');
      return { cancelled: false, reason: 'NOT_CONFIRMED' };
    }

    // 釋回槽位。auto 槽位同時把預約時認領的場館還原成 NULL，維持跨場館共用與旗標可控。
    await client.query(
      `UPDATE coach_availability_slots
          SET status = 'available', booked_session_id = NULL,
              venue_id = CASE WHEN generated_by = 'auto' THEN NULL ELSE venue_id END,
              updated_at = NOW()
        WHERE booked_session_id = $1`,
      [sessionId]
    );

    // 重算權威已用堂數（與 routes/checkins.js 同一條查詢），寫回 legacy 鏡射欄位。
    const usedRes = await client.query(
      `SELECT COUNT(DISTINCT cs.id)::int AS n
         FROM course_sessions cs
         JOIN checkin_records cr ON cr.course_session_id = cs.id
        WHERE cs.course_period_id = $1 AND cs.status::text NOT LIKE 'cancelled%'
          AND cr.attendance_status = 'ATTENDED'`,
      [ctx.rows[0].id]
    );
    await syncStoredUsage(client, ctx.rows[0], Number(usedRes.rows[0]?.n || 0));

    await client.query('COMMIT');
    return { cancelled: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { detectConflict, createSlot, batchCreateSlots, bookSlot1v1, cancelSession };
