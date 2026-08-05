/**
 * 簽到確認推播 —— 教練 + 家長。
 *
 * 三條簽到路徑（教練代簽 / 家長自助 / 櫃台補登）共用這裡，避免三份各自演化成
 * 不同的文案與收訊者規則。
 *
 * ── 路由邊界（重要）──
 * uid 從哪個 provider 進來，就只能推回同一個 provider。收訊者的 channel 一律由
 * services/lineRouting.js 決定，「不」用學員的 venue_id 去猜 —— 實測家長 uid 對
 * 場館官方帳號的可達率是 0/60，用 venue_id 推會安靜地送出一整排 404。
 * 路由查不到就直接記錄原因並跳過，絕不退而求其次試別的 channel。
 *
 * ── 收訊者規則 ──
 * 教練：只在「不是教練自己簽的」時通知。教練代簽時通知他自己是純噪音，而且共班
 *       一次寫入整班會變成一堂課發 N 則 —— 教練端 channel 全場館共用，每月只有
 *       3,000 則額度，禁不起這樣燒。
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
function resolveChannel(row, who) {
  const ch = routing.channelForRecipient(row);
  if (!ch) {
    const key = String(row && row.line_login_channel_id || process.env.LINE_LOGIN_CHANNEL_ID || '(未設)');
    if (!_warnedRoute.has(key)) {
      _warnedRoute.add(key);
      console.error('[checkinNotify] Login channel ' + key + ' 沒有對應的 Messaging channel，'
        + who + '通知全部跳過。請在 services/lineRouting.js 的 PROVIDER_ROUTES 補上對應。');
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
            co.name AS coach_name, co.line_uid AS coach_uid,
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
    if (r.coach_uid && r.checked_in_source !== 'coach') {
      const ch = resolveChannel(r, '教練');
      if (!ch) { out.skipped += 1; }
      else {
        try {
          const res = await line.pushMessage(
            r.coach_uid,
            line.templates.checkinConfirmedToCoach({
              studentName: r.student_name,
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
      const ch = resolveChannel(r, '家長');
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