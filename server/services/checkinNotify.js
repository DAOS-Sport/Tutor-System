/**
 * 簽到確認推播 —— 教練 + 家長。
 *
 * 兩條簽到路徑（家長自助 / 櫃台補登）共用這裡，避免兩份各自演化成
 * 不同的文案與收訊者規則。
 * （教練代簽原為第三條，已於 2026-08-10 完整移除；DB 仍有 'coach' 來源的歷史列。）
 *
 * ── 路由邊界（重要）──
 * uid 從哪個 provider 進來，就只能推回同一個 provider。收訊者的 channel 一律由
 * services/lineRouting.js 決定，「不」用學員的 venue_id 去猜 —— 實測家長 uid 對
 * 場館官方帳號的可達率是 0/60，用 venue_id 推會安靜地送出一整排 404。
 * 路由查不到就直接記錄原因並跳過，絕不退而求其次試別的 channel。
 *
 * ── 收訊者規則 ──
 * 教練：checkin_records.checked_in_source = 'coach' 的列不通知。新資料不會再有這個
 *       來源（代簽已移除），但本函式是以 sessionId 撈「該堂全部已簽到列」，
 *       一堂舊課可能同時有歷史 coach 列與後來的 parent 列 —— 條件拿掉的話，
 *       教練會收到「他自己當年簽的那筆」推播噪音。
 * 家長：一律通知（他要知道小孩到了、這堂課被計走了）。
 *
 * 兩者是「獨立的事件開關」，可以只開教練端。
 * 一律 best-effort：推播失敗絕不能影響簽到本身（簽到已經 COMMIT 了）。
 * 去重靠 pushGate 的 refId（checkin_records.id），同一筆簽到只會通知一次。
 */
const line = require('./line');
const routing = require('./lineRouting');
const { pool } = require('../models/db');

const EVENT_COACH = 'checkin_confirmed_coach';
const EVENT_PARENT = 'checkin_confirmed_parent';

// 路由查不到時每個 login channel 只吵一次，避免整批簽到刷出一排相同錯誤。
const _warnedRoute = new Set();
async function resolveChannel({ kind, venueId }, who) {
  const r = await routing.resolveChannel({ kind, venueId });
  const ch = r && r.channel;
  if (!ch) {
    // 同一種缺法只吵一次，避免整批簽到刷出一排相同錯誤把真問題淹掉。
    const key = kind + '|' + String(venueId || '-');
    if (!_warnedRoute.has(key)) {
      _warnedRoute.add(key);
      console.error('[checkinNotify] 找不到' + who + '的推播目的地（場館=' + (venueId || '-')
        + '），該類通知全部跳過。請確認 services/lineRouting.js 的 STAFF_CHANNEL 有 token。');
    }
  }
  return ch;
}

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
            p.name AS parent_name,
            cp.course_type AS course_type,
            p.primary_venue_id AS parent_venue_id,
            p.line_login_channel_id AS parent_login_channel,
            co.name AS coach_name, co.line_uid AS coach_uid,
            co.line_login_channel_id AS coach_login_channel,
            cp.venue_id, v.name AS venue_name
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
 */
async function notifyCheckin(sessionId, studentIds, db = pool) {
  const out = { coach: 0, parent: 0, skipped: 0, failed: 0 };
  let rows;
  try {
    rows = await loadCheckins(db, sessionId, studentIds);
  } catch (e) {
    console.warn('[checkinNotify] 查詢失敗：' + e.message);
    return out;
  }

  for (const r of rows) {
    const when = r.checked_in_at instanceof Date ? r.checked_in_at.toISOString() : String(r.checked_in_at);

    // ── 教練 ──（教練自己簽的就不用通知他自己）
    // 'coach' 僅存在於歷史列（代簽已於 2026-08-10 移除）。這不是死碼 ——
    // 見檔頭「收訊者規則」：舊課的歷史 coach 列會混在同一批被撈出來。
    if (r.coach_uid && r.checked_in_source !== 'coach') {
      const ch = await resolveChannel({ kind: 'coach' }, '教練');
      if (!ch) { out.skipped += 1; }
      else {
        try {
          const res = await line.pushMessage(
            r.coach_uid,
            line.templates.checkinConfirmedToCoach({
              parentName: r.parent_name,
              studentName: r.student_name,
              courseType: r.course_type ? '1 對 ' + r.course_type : null,
              venueName: r.venue_name || r.venue_id,
              checkedInAt: when,
              source: r.checked_in_source,
            }),
            ch,
            { event: EVENT_COACH, refId: 'c:' + r.checkin_id, recipientKind: 'coach' });
          if (res && res.sent) out.coach += 1;
        } catch (e) { out.failed += 1; console.warn('[checkinNotify] 教練推播失敗：' + e.message); }
      }
    }

    // ── 家長 ──
    if (r.parent_uid) {
      const ch = await resolveChannel({ kind: 'parent', venueId: r.parent_venue_id }, '家長');
      if (!ch) { out.skipped += 1; }
      else {
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
            ch,
            { event: EVENT_PARENT, refId: 'p:' + r.checkin_id, recipientKind: 'parent' });
          if (res && res.sent) out.parent += 1;
        } catch (e) { out.failed += 1; console.warn('[checkinNotify] 家長推播失敗：' + e.message); }
      }
    }
  }
  return out;
}

// 呼叫端用這個：簽到已經 COMMIT，推播不該把它拖下水，也不該讓它 throw 出去。
function notifyCheckinSafely(sessionId, studentIds, db) {
  Promise.resolve()
    .then(() => notifyCheckin(sessionId, studentIds, db))
    .catch((e) => console.warn('[checkinNotify] 未預期例外：' + e.message));
}

module.exports = { EVENT_COACH, EVENT_PARENT, notifyCheckin, notifyCheckinSafely };