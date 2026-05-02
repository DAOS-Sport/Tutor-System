/**
 * 聊天室授權 / 查詢 / 建立 helper
 *
 * 規則（與 spec F-S09 / F-C03 / F-M03 對齊）：
 *  - 一個 course_period 對應一個 chat_room（unique）
 *  - 家長：必須在該 period 的 enrollments 中（透過孩子 student_id 連到 parent_id）
 *  - 教練：必須是該 period 的 coach_id
 *  - admin/manager：永遠可讀（F-M03 監察用，唯讀）
 *
 * 對外介面：
 *  - ensureRoomForPeriod(periodId): 冪等建立並回傳 room
 *  - listRoomsForParent(parentId)  / listRoomsForCoach(coachId) / listRoomsForAdmin()
 *  - canAccess({ roomId, role, userId }): boolean
 *  - latestSummary(roomId, viewer): 用於 list 顯示最後一則 + 未讀數
 */
const { pool } = require('../models/db');

async function ensureRoomForPeriod(periodId) {
  const r = await pool.query(
    `INSERT INTO chat_rooms (course_period_id) VALUES ($1)
     ON CONFLICT (course_period_id) DO UPDATE SET course_period_id = EXCLUDED.course_period_id
     RETURNING id, course_period_id, created_at`,
    [periodId]
  );
  return r.rows[0];
}

/**
 * 將 course_period 切到 active，並冪等建立對應 chat_room（spec F-S09）。
 * 呼叫端可以是 admin 對帳通過、cron 排程或任何後端流程，保證
 * 「狀態變 active 即有聊天室」的不變式不會漂移。
 */
async function transitionPeriodToActive(periodId) {
  const upd = await pool.query(
    `UPDATE course_periods SET status = 'active', updated_at = NOW()
       WHERE id = $1 AND status <> 'active'
       RETURNING id`,
    [periodId]
  );
  const room = await ensureRoomForPeriod(periodId);
  return { activated: upd.rowCount > 0, room };
}

/**
 * 後援：把所有 active 但缺 chat_room 的 period 補上（cron 用）。
 * 與 bootstrap.ensureChatRoomsForActivePeriods 等價，留在 service 給排程引用。
 */
async function backfillRoomsForActivePeriods() {
  const r = await pool.query(`
    INSERT INTO chat_rooms (course_period_id)
    SELECT cp.id FROM course_periods cp
    LEFT JOIN chat_rooms cr ON cr.course_period_id = cp.id
    WHERE cp.status = 'active' AND cr.id IS NULL
    ON CONFLICT (course_period_id) DO NOTHING
    RETURNING id`);
  return r.rowCount;
}

const ROOM_BASE_SELECT = `
  SELECT cr.id AS room_id,
         cr.course_period_id,
         cp.coach_id,
         co.name AS coach_name,
         cp.venue_id,
         v.name  AS venue_name,
         cp.course_type,
         cp.status AS period_status,
         (SELECT array_agg(DISTINCT s.name)
            FROM course_period_enrollments e JOIN students s ON s.id = e.student_id
           WHERE e.course_period_id = cp.id AND e.status = 'active') AS student_names,
         (SELECT array_agg(DISTINCT s.parent_id)
            FROM course_period_enrollments e JOIN students s ON s.id = e.student_id
           WHERE e.course_period_id = cp.id AND e.status = 'active') AS parent_ids,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.chat_room_id = cr.id) AS last_message_at
    FROM chat_rooms cr
    JOIN course_periods cp ON cp.id = cr.course_period_id
    JOIN coaches co ON co.id = cp.coach_id
    JOIN venues v   ON v.id  = cp.venue_id
`;
// 排序：最近活躍訊息優先，沒有訊息時 fallback 到聊天室建立時間
const ROOM_RECENCY_ORDER = `ORDER BY COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.chat_room_id = cr.id), cr.created_at) DESC`;

async function _hydrate(rows, viewer) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.room_id);
  const last = await pool.query(
    `SELECT DISTINCT ON (chat_room_id) chat_room_id, sender_type, sender_id, message_type, content,
            media_url, media_filename, created_at
       FROM messages WHERE chat_room_id = ANY($1)
       ORDER BY chat_room_id, created_at DESC`,
    [ids]
  );
  const lastMap = new Map(last.rows.map((m) => [m.chat_room_id, m]));

  // 未讀數：對 viewer 而言 — 排除自己發的、且未在 message_reads 標記
  let unreadMap = new Map();
  if (viewer && viewer.type !== 'admin') {
    const ur = await pool.query(
      `SELECT m.chat_room_id, COUNT(*)::int AS n
         FROM messages m
        WHERE m.chat_room_id = ANY($1)
          AND NOT (m.sender_type = $2 AND m.sender_id = $3)
          AND NOT EXISTS (
            SELECT 1 FROM message_reads r
             WHERE r.message_id = m.id AND r.reader_type = $2 AND r.reader_id = $3
          )
        GROUP BY m.chat_room_id`,
      [ids, viewer.type, viewer.id]
    );
    unreadMap = new Map(ur.rows.map((r) => [r.chat_room_id, r.n]));
  }

  return rows.map((r) => {
    const lm = lastMap.get(r.room_id);
    return {
      id: r.room_id,
      course_period_id: r.course_period_id,
      coach: { id: r.coach_id, name: r.coach_name },
      venue: { id: r.venue_id, name: r.venue_name },
      course_type: r.course_type,
      period_status: r.period_status,
      student_names: r.student_names || [],
      last_message: lm ? {
        sender_type: lm.sender_type,
        message_type: lm.message_type,
        content: lm.content,
        media_filename: lm.media_filename,
        created_at: lm.created_at,
      } : null,
      unread_count: unreadMap.get(r.room_id) || 0,
    };
  });
}

async function listRoomsForParent(parentId) {
  const r = await pool.query(`
    ${ROOM_BASE_SELECT}
    WHERE EXISTS (
      SELECT 1 FROM course_period_enrollments e
      JOIN students s ON s.id = e.student_id
      WHERE e.course_period_id = cp.id AND e.status = 'active' AND s.parent_id = $1
    )
    ${ROOM_RECENCY_ORDER}
  `, [parentId]);
  return _hydrate(r.rows, { type: 'parent', id: parentId });
}

async function listRoomsForCoach(coachId) {
  const r = await pool.query(`${ROOM_BASE_SELECT} WHERE cp.coach_id = $1 ${ROOM_RECENCY_ORDER}`, [coachId]);
  return _hydrate(r.rows, { type: 'coach', id: coachId });
}

async function listRoomsForAdmin({ search, venueId } = {}) {
  const args = [];
  const where = [];
  if (venueId) { args.push(venueId); where.push(`cp.venue_id = $${args.length}`); }
  if (search) {
    args.push(`%${String(search).toLowerCase()}%`);
    const i = args.length;
    where.push(`(LOWER(co.name) LIKE $${i} OR LOWER(v.name) LIKE $${i} OR LOWER(cp.id::text) LIKE $${i})`);
  }
  const sql = `${ROOM_BASE_SELECT}
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ${ROOM_RECENCY_ORDER} LIMIT 200`;
  const r = await pool.query(sql, args);
  return _hydrate(r.rows, { type: 'admin', id: null });
}

async function canAccess({ roomId, role, userId, venueId } = {}) {
  if (!roomId) return false;
  if (role === 'admin') {
    const r = await pool.query(`SELECT 1 FROM chat_rooms WHERE id = $1`, [roomId]);
    return r.rowCount > 0;
  }
  if (role === 'manager') {
    // venue-scoped：必須是該 venueId 內的 room（與 admin HTTP 端 manager 範圍一致）
    if (!venueId) return false;
    const r = await pool.query(
      `SELECT 1 FROM chat_rooms cr
         JOIN course_periods cp ON cp.id = cr.course_period_id
        WHERE cr.id = $1 AND cp.venue_id = $2`, [roomId, venueId]);
    return r.rowCount > 0;
  }
  // staff 不得查閱聊天內容（F-M03 policy，docs/adr_phase4_chat.md §4）
  if (role === 'staff') return false;
  if (role === 'coach') {
    const r = await pool.query(
      `SELECT 1 FROM chat_rooms cr JOIN course_periods cp ON cp.id = cr.course_period_id
        WHERE cr.id = $1 AND cp.coach_id = $2`, [roomId, userId]);
    return r.rowCount > 0;
  }
  if (role === 'parent') {
    const r = await pool.query(
      `SELECT 1 FROM chat_rooms cr
         JOIN course_period_enrollments e ON e.course_period_id = cr.course_period_id
         JOIN students s ON s.id = e.student_id
        WHERE cr.id = $1 AND e.status = 'active' AND s.parent_id = $2`, [roomId, userId]);
    return r.rowCount > 0;
  }
  return false;
}

async function getRoomMeta(roomId) {
  const r = await pool.query(`${ROOM_BASE_SELECT} WHERE cr.id = $1`, [roomId]);
  if (!r.rows.length) return null;
  const list = await _hydrate(r.rows, null);
  return list[0];
}

module.exports = {
  ensureRoomForPeriod,
  transitionPeriodToActive,
  backfillRoomsForActivePeriods,
  listRoomsForParent,
  listRoomsForCoach,
  listRoomsForAdmin,
  canAccess,
  getRoomMeta,
};
