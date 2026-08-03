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
 * 取消課程時段（學員自助），釋回槽位
 */
async function cancelSession(sessionId, cancelType) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE course_sessions SET status = $1, cancelled_at = NOW() WHERE id = $2`,
      [`cancelled_${cancelType}`, sessionId]
    );
    // 釋回槽位
    await client.query(
      `UPDATE coach_availability_slots SET status = 'available', booked_session_id = NULL
       WHERE booked_session_id = $1`,
      [sessionId]
    );
    // 若正常取消，歸還堂數
    if (cancelType === 'normal') {
      await client.query(
        `UPDATE course_periods SET used_sessions = used_sessions - 1
         WHERE id = (SELECT course_period_id FROM course_sessions WHERE id = $1)
           AND used_sessions > 0`,
        [sessionId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { detectConflict, createSlot, batchCreateSlots, bookSlot1v1, cancelSession };
