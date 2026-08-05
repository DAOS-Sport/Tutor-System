/**
 * 簽到確認推播 —— 家長 + 教練。
 *
 * 三條簽到路徑（教練代簽 / 家長自助 / 櫃台補登）共用這裡，避免三份各自
 * 演化成不同的文案與收訊者規則。
 *
 * 收訊者規則：
 *   家長：一律通知（他要知道小孩到了）
 *   教練：只在「不是教練自己簽的」時候通知。教練代簽時通知他自己是純噪音，
 *         而且共班一次寫入整班，會變成一堂課發 N 則 —— 教練端那個官方帳號
 *         每月只有 3,000 則額度，全場館共用，禁不起這樣燒。
 *
 * 一律 best-effort：推播失敗絕不能影響簽到本身（簽到已經 COMMIT 了）。
 * 去重靠 pushGate 的 refId（checkin_records.id），同一筆簽到只會通知一次。
 */
const line = require('./line');
const { pool } = require('../models/db');

const EVENT = 'checkin_confirmed';

// 教練端統一走這個場館代號的 token（400_駿斯內部服務窗口）。
// 教練不隸屬單一場館，用學員的場館去查會把教練通知拆散到各館官方帳號。
const COACH_CHANNEL = process.env.LINE_COACH_VENUE_ID || 'dreams400';

async function loadCheckins(db, sessionId, studentIds) {
  const params = [sessionId];
  let filter = '';
  if (Array.isArray(studentIds) && studentIds.length) {
    params.push(studentIds);
    filter = ' AND cr.student_id = ANY($2::uuid[])';
  }
  const r = await db.query(
    `SELECT cr.id AS checkin_id, cr.checked_in_at, cr.checked_in_source,
            s.name AS student_name,
            p.line_uid AS parent_uid,
            co.name AS coach_name, co.line_uid AS coach_uid,
            cp.venue_id, v.name AS venue_name,
            cs.scheduled_at
       FROM checkin_records cr
       JOIN course_sessions cs ON cs.id = cr.course_session_id
       JOIN course_periods cp ON cp.id = cs.course_period_id
       JOIN students s ON s.id = cr.student_id
       LEFT JOIN parents p ON p.id = s.parent_id
       LEFT JOIN coaches co ON co.id = COALESCE(cs.coach_id, cp.coach_id)
       LEFT JOIN venues v ON v.id = cp.venue_id
      WHERE cr.course_session_id = $1
        AND cr.attendance_status = 'ATTENDED'${filter}`,
    params);
  return r.rows;
}

/**
 * 為某堂課的簽到發出通知。
 * @param {string} sessionId course_sessions.id
 * @param {string[]} [studentIds] 只通知這些學員（省略＝該堂全部已簽到的）
 * @returns {Promise<{parent:number, coach:number, failed:number}>}
 */
async function notifyCheckin(sessionId, studentIds, db = pool) {
  const out = { parent: 0, coach: 0, failed: 0 };
  let rows;
  try {
    rows = await loadCheckins(db, sessionId, studentIds);
  } catch (e) {
    console.warn('[checkinNotify] 查詢失敗：' + e.message);
    return out;
  }

  for (const r of rows) {
    const when = r.checked_in_at instanceof Date ? r.checked_in_at.toISOString() : String(r.checked_in_at);

    if (r.parent_uid) {
      try {
        const res = await line.pushMessage(
          r.parent_uid,
          line.templates.checkinConfirmed({
            studentName: r.student_name,
            coachName: r.coach_name,
            venueName: r.venue_name || r.venue_id,
            checkedInAt: when,
            liffUrl: process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '',
          }),
          r.venue_id,
          { event: EVENT, refId: 'p:' + r.checkin_id, recipientKind: 'parent' });
        if (res && res.sent) out.parent += 1;
      } catch (e) { out.failed += 1; console.warn('[checkinNotify] 家長推播失敗：' + e.message); }
    }

    // 教練自己簽的就不用再通知他自己
    if (r.coach_uid && r.checked_in_source !== 'coach') {
      try {
        const res = await line.pushMessage(
          r.coach_uid,
          line.templates.checkinConfirmedToCoach({
            studentName: r.student_name,
            venueName: r.venue_name || r.venue_id,
            checkedInAt: when,
            source: r.checked_in_source,
          }),
          COACH_CHANNEL,
          { event: EVENT, refId: 'c:' + r.checkin_id, recipientKind: 'coach' });
        if (res && res.sent) out.coach += 1;
      } catch (e) { out.failed += 1; console.warn('[checkinNotify] 教練推播失敗：' + e.message); }
    }
  }
  return out;
}

// 給呼叫端用的 fire-and-forget 包裝：簽到已經 COMMIT，推播不該把它拖下水。
function notifyCheckinSafely(sessionId, studentIds, db) {
  notifyCheckin(sessionId, studentIds, db)
    .catch((e) => console.warn('[checkinNotify] 未預期例外：' + e.message));
}

module.exports = { EVENT, notifyCheckin, notifyCheckinSafely };