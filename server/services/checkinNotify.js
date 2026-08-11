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
/**
 * 把該堂課的多筆簽到列彙整成「給教練的一則」。回 null＝這堂不該通知教練。
 *
 * ── 為什麼要彙整 ──
 * 共班簽到是一次原子寫入整班（checkins.js 的 SHARED_CHECKIN_USAGE_V2 分支直接
 * SELECT 整個 roster 做 INSERT），櫃檯手動扣課也是。逐列推播的話，一堂 1對3 的課
 * 教練手機會連響三次，內容幾乎一樣。dreams400 是全場館共用、每月只有 3,000 則
 * 額度 —— 這樣燒撐不住，而且通知一多就沒人看，真正要當下反應的那則會被淹掉。
 *
 * 抽成純函式是為了能單獨測：誰入選、家長怎麼標、學員怎麼併、時間取哪一個，
 * 都不需要資料庫也不需要 LINE 就能驗。
 */
function buildCoachSummary(rows) {
  // 'coach' 來源僅存在於歷史列（代簽已於 2026-08-10 移除）。見檔頭收訊者規則。
  const usable = (rows || []).filter((r) => r && r.coach_uid && r.checked_in_source !== 'coach');
  if (!usable.length) return null;
  const first = usable[0];

  const uniq = (xs) => Array.from(new Set(xs.map((x) => String(x || '').trim()).filter(Boolean)));
  const students = uniq(usable.map((r) => r.student_name));
  const parents = uniq(usable.map((r) => r.parent_name));

  // 共班可能跨家庭。硬挑第一位家長當代表，會讓教練看到一個跟其他學員不相干的
  // 名字，所以多於一位時改標數量。
  const parentLabel = parents.length === 1 ? parents[0]
    : (parents.length > 1 ? parents.length + ' 位家長' : null);

  // 批次是原子寫入，時間本來就幾乎相同；取最早的，語意是「這堂課的簽到時間」。
  const times = usable
    .map((r) => new Date(r.checked_in_at))
    .filter((d) => !Number.isNaN(d.getTime()));
  const checkedInAt = times.length ? new Date(Math.min.apply(null, times.map((d) => d.getTime()))) : null;

  return {
    coachUid: first.coach_uid,
    parentLabel,
    studentNames: students,
    courseType: first.course_type ? '1 對 ' + first.course_type : null,
    venueName: first.venue_name || first.venue_id || null,
    checkedInAt: checkedInAt ? checkedInAt.toISOString() : null,
    source: first.checked_in_source,
  };
}

async function notifyCheckin(sessionId, studentIds, db = pool) {
  const out = { coach: 0, parent: 0, skipped: 0, failed: 0 };
  let rows;
  try {
    rows = await loadCheckins(db, sessionId, studentIds);
  } catch (e) {
    console.warn('[checkinNotify] 查詢失敗：' + e.message);
    return out;
  }

  // ── 教練：一堂課一則 ──
  // refId 用 sessionId 而不是 checkin_id，讓去重索引把「一堂課」收斂成一則。
  // 逐列推的話共班會一次發 N 則；而手動扣課那支是在 roster 迴圈裡呼叫，
  // 沒有這層收斂會變成 N×N 次嘗試（去重擋掉大部分，但仍會送出 N 則）。
  const summary = buildCoachSummary(rows);
  if (summary) {
    const ch = await resolveChannel({ kind: 'coach' }, '教練');
    if (!ch) { out.skipped += 1; }
    else {
      try {
        const res = await line.pushMessage(
          summary.coachUid,
          line.templates.checkinConfirmedToCoach({
            // 不再傳 parentName —— 2026-08-11 起樣板主標是學員名單，完全不顯示家長。
            // summary.parentLabel 仍保留（見 buildCoachSummary），日後要加回家長欄時
            // 那段「不硬挑第一位家長」的判斷還用得到。
            studentNames: summary.studentNames,
            courseType: summary.courseType,
            venueName: summary.venueName,
            checkedInAt: summary.checkedInAt,
            source: summary.source,
          }),
          ch,
          { event: EVENT_COACH, refId: 'cs:' + sessionId, recipientKind: 'coach' });
        if (res && res.sent) out.coach += 1;
      } catch (e) { out.failed += 1; console.warn('[checkinNotify] 教練推播失敗：' + e.message); }
    }
  }

  for (const r of rows) {
    const when = r.checked_in_at instanceof Date ? r.checked_in_at.toISOString() : String(r.checked_in_at);

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

module.exports = { EVENT_COACH, EVENT_PARENT, notifyCheckin, notifyCheckinSafely, buildCoachSummary };