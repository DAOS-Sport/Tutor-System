/**
 * 關鍵字命中後的 LINE 推播分派（盡量輕量、失敗不影響聊天）
 *
 * 收件對象：admin / manager 角色，且具備 line_uid（後台帳號表 schema 不一定有此欄位 → 安全 fallback）。
 * 找到 line_uid 就推 keywordAlert Flex；以該聊天室的 venue 對應的 LINE channel token 發送。
 *
 * 設計考量：
 *  - 此模組故意 wrap 在 try/catch，並接受 line.js 不存在 keywordAlert 模板時的降級為 console.warn
 *  - 不阻塞訊息送達，呼叫端 fire-and-forget
 */
const { pool } = require('../models/db');

let lineService = null;
try { lineService = require('../services/line'); } catch { /* optional */ }

/**
 * 找出該聊天室所屬的 venueId（用於 LINE channel token 路由）
 */
async function getRoomVenueId(roomId) {
  const r = await pool.query(`
    SELECT cp.venue_id
      FROM chat_rooms cr
      JOIN course_periods cp ON cp.id = cr.course_period_id
     WHERE cr.id = $1`, [roomId]);
  return r.rows[0]?.venue_id || null;
}

/**
 * 動態挑出 admin_users 表中具備 line_uid 的主管。
 * 若該欄位尚未在資料庫中存在，pg 會丟錯，這裡安全 fallback 為空陣列。
 */
async function listSupervisors() {
  const supervisors = [];
  try {
    const r = await pool.query(`
      SELECT name, role, line_uid
        FROM admin_users
       WHERE role IN ('admin','manager')
         AND line_uid IS NOT NULL AND line_uid <> ''
    `);
    for (const u of r.rows) supervisors.push({ ...u, source: 'admin_users' });
  } catch (err) {
    if (!/column .*line_uid.* does not exist/i.test(err.message)) {
      console.warn('[chat-alert] listSupervisors admin_users error:', err.message);
    }
  }
  return supervisors;
}

async function notifyKeywordAlert({ roomId, message, alerts }) {
  try {
    const supervisors = await listSupervisors();
    const summary = alerts.map((a) => a.triggered_keyword).join('、');
    console.log(`[chat-alert] room=${roomId} keywords=[${summary}] supervisors=${supervisors.length}`);

    if (!lineService || typeof lineService.pushKeywordAlert !== 'function') return;
    if (!supervisors.length) return;

    const venueId = await getRoomVenueId(roomId);
    if (!venueId) {
      console.warn('[chat-alert] no venueId for room', roomId);
      return;
    }

    for (const sup of supervisors) {
      try {
        await lineService.pushKeywordAlert(sup.line_uid, {
          venueId,
          keyword: summary,
          chatRoomId: roomId,
          snippet: (message?.content || '').slice(0, 60),
        });
      } catch (e) {
        console.warn(`[chat-alert] push to ${sup.name} failed:`, e.message);
      }
    }
  } catch (err) {
    console.warn('[chat-alert] notifyKeywordAlert error:', err.message);
  }
}

module.exports = { notifyKeywordAlert };
