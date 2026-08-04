'use strict';
/**
 * 「這個場館在這個時間真的有開嗎」——預約當下的最後一道驗證。
 *
 * 為什麼產生端擋不完，一定要有這一層：
 *
 * 1. 自動時段的 venue_id 是 NULL（語意＝「這位教練這個時間有空」），到預約當下
 *    才被課期的場館認領。產生時是拿「教練所屬全部場館的聯集」算的，所以某一格
 *    可能只有 A 館有開，卻被 B 館的課期認領走。
 * 2. 休館日在產生端只有「教練所屬全部場館都休館」才整天不產生——否則 A 館公休
 *    會誤刪他在 B 館的時間。但反過來說，A 館的家長就約得到 A 館的公休日。
 * 3. 營業時間被縮短時，依舊時間產生的既有時段不會被回收（產生器只新增不刪改）。
 *
 * 這三件事都在「已經產生出來的格子」上，只有預約當下拿著確定的場館才判得準。
 * fail-closed：查不到營業時間就是不准約。
 *
 * 只驗自動時段。教練手動加開的時段本來就是「營業時間以外的臨時加開」，
 * 拿營業時間去否決它會把那個功能整個廢掉。
 */

/** 'HH:MM[:SS]' → 當日分鐘數 */
function toMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(v) ? v : null;
}

/**
 * 純判定。
 * @param {object} p
 * @param {number} p.weekday        0=日..6=六（台北）
 * @param {number} p.startMinutes   當日開始分鐘（台北）
 * @param {number} p.durationMinutes
 * @param {boolean} p.isClosedDate  該日是否為該場館的特殊休館日
 * @param {Array}  p.hours          該場館 is_active 的營業時間列
 * @returns {{ open: boolean, reason: string|null }}
 */
function evaluateOpening({ weekday, startMinutes, durationMinutes, isClosedDate, hours }) {
  if (isClosedDate) return { open: false, reason: 'VENUE_CLOSED_DATE' };
  if (!Array.isArray(hours) || hours.length === 0) {
    return { open: false, reason: 'VENUE_NO_BUSINESS_HOURS' };
  }
  const end = startMinutes + Number(durationMinutes || 0);
  // 跨午夜：本 schema 的營業時間不跨日，跨過去就無從比對，一律擋。
  if (end > 24 * 60) return { open: false, reason: 'VENUE_HOURS_MISMATCH' };

  const fits = hours.some((h) => {
    if (Number(h.weekday) !== Number(weekday)) return false;
    const o = toMinutes(h.open_time);
    const c = toMinutes(h.close_time);
    if (o == null || c == null || c <= o) return false;
    // 必須「完整放得下」：只有開始時間落在營業時間內不夠，
    // 22:30 開始的 60 分課在 23:00 打烊的館是關門後還在上課。
    return startMinutes >= o && end <= c;
  });
  return fits ? { open: true, reason: null } : { open: false, reason: 'VENUE_HOURS_MISMATCH' };
}

const MESSAGES = {
  VENUE_CLOSED_DATE: '該場館當天休館，請改選其他時間',
  VENUE_NO_BUSINESS_HOURS: '該場館尚未設定營業時間，暫時無法預約，請洽櫃檯',
  VENUE_HOURS_MISMATCH: '此時段不在該場館的營業時間內，請改選其他時間',
};

function openingRejectMessage(reason) {
  return MESSAGES[reason] || '此時段目前無法預約，請洽櫃檯';
}

/**
 * DB 版：撈該場館的營業時間與該日休館狀態後交給純函式判定。
 * @param {object} db  pg client（呼叫端交易內）或 pool
 */
async function checkVenueOpen(db, { venueId, startAt, durationMinutes }) {
  const r = await db.query(
    `SELECT
       EXTRACT(DOW FROM ($2::timestamptz AT TIME ZONE 'Asia/Taipei'))::int AS weekday,
       (EXTRACT(HOUR FROM ($2::timestamptz AT TIME ZONE 'Asia/Taipei')) * 60
        + EXTRACT(MINUTE FROM ($2::timestamptz AT TIME ZONE 'Asia/Taipei')))::int AS start_minutes,
       EXISTS (SELECT 1 FROM venue_closed_dates c
                WHERE c.venue_id = $1
                  AND c.closed_date = ($2::timestamptz AT TIME ZONE 'Asia/Taipei')::date) AS is_closed_date`,
    [venueId, startAt]
  );
  const ctx = r.rows[0];
  const hours = await db.query(
    `SELECT weekday, open_time, close_time FROM venue_business_hours
      WHERE venue_id = $1 AND is_active`,
    [venueId]
  );
  return evaluateOpening({
    weekday: ctx.weekday,
    startMinutes: ctx.start_minutes,
    durationMinutes,
    isClosedDate: ctx.is_closed_date === true,
    hours: hours.rows,
  });
}

module.exports = { evaluateOpening, checkVenueOpen, openingRejectMessage, toMinutes };