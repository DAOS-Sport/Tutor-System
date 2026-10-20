'use strict';

// 堂次編號與購買堂數上限（讀取端）；不寫入出席、扣課或餘額。
// Owner 2026-10-12：只要有人簽到就是整班上了一堂、教練計一堂；同一筆購買的教練堂數
// 以購買堂數為上限（每期 total_sessions 加總），超過的簽到保留紀錄但不計教練堂數。
const text = value => value == null ? '' : String(value).trim();
const purchaseSql = (cp, ae) => `COALESCE(to_jsonb(${cp})->>'group_order_id',to_jsonb(${ae})->>'group_order_id',
  to_jsonb(${cp})->>'enrollment_batch_id',to_jsonb(${ae})->>'enrollment_batch_id',
  to_jsonb(${cp})->>'admin_enrollment_id',${cp}.id::text)`;
const sharedKey = (purchase, venue, courseType, experience) =>
  JSON.stringify(['class', text(purchase), text(venue), Number(courseType), Boolean(experience)]);

// 共班：同一購買（同場館、組別）是一個班，跨期號、跨教練一起編號。
// 獨立一對一：各課期自己編號。
function classKey(row) {
  const identity = row.report_identity;
  if (!identity || !text(identity.purchase_id) || !text(identity.period_id)) return null;
  return identity.shared_purchase === true
    ? sharedKey(identity.purchase_id, row.venue_id, row.course_type, row.is_experience_course)
    : JSON.stringify(['period', text(identity.period_id)]);
}

// 查詢區間只是畫面範圍；堂次必須用同一購買的完整歷史來數，否則區間從中途開始會從 1 重編。
async function loadClassScope(pool, baseSelect, rangeRows) {
  const purchases = [...new Set(rangeRows.map(row => text(row.report_identity?.purchase_id)).filter(Boolean))];
  if (!purchases.length) return { history: [], capacities: new Map(), periodCaps: new Map() };
  const history = (await pool.query(`${baseSelect}
     WHERE cs.status::text NOT LIKE 'cancelled%'
       AND ${purchaseSql('cp', 'ae')} = ANY($1::text[])`, [purchases])).rows;
  // 每個期號取一次該期堂數（共班各學員的課期是同一期的鏡射，不重複加）。
  // 已退費訂單若沒有任何有效出席就不算進上限；有出席過的歷史期照算。
  const result = await pool.query(`SELECT purchase, venue_id, course_type, is_experience_course, SUM(total)::int AS capacity,
             json_agg(json_build_array(period_number, total) ORDER BY period_number) AS periods
      FROM (SELECT ${purchaseSql('cp', 'ae')} AS purchase, cp.venue_id::text AS venue_id, cp.course_type,
                   COALESCE(cp.is_experience_course, FALSE) AS is_experience_course,
                   COALESCE((to_jsonb(ae)->>'period_number')::int, (to_jsonb(cp)->>'period_number')::int, 1) AS period_number,
                   MAX(cp.total_sessions) AS total
              FROM course_periods cp
              LEFT JOIN admin_enrollments ae ON ae.id = cp.admin_enrollment_id
             WHERE ${purchaseSql('cp', 'ae')} = ANY($1::text[])
               AND (COALESCE(to_jsonb(ae)->>'status', '') NOT IN ('refunded', 'cancelled')
                    OR EXISTS (SELECT 1 FROM course_sessions cs
                                 JOIN checkin_records cr ON cr.course_session_id = cs.id
                                WHERE cs.course_period_id = cp.id AND cs.status::text NOT LIKE 'cancelled%'
                                  AND cr.attendance_status = 'ATTENDED'))
             GROUP BY 1, 2, 3, 4, 5) periods
     GROUP BY 1, 2, 3, 4`, [purchases]);
  // capacities：全班購買堂數（各期加總）；periodCaps：各期堂數（依期號），堂號用它決定落在第幾期第幾堂。
  const capacities = new Map(), periodCaps = new Map();
  for (const row of result.rows) {
    const key = sharedKey(row.purchase, row.venue_id, row.course_type, row.is_experience_course);
    capacities.set(key, Number(row.capacity));
    periodCaps.set(key, (row.periods || []).map(pair => [Number(pair[0]), Number(pair[1]) || 0]));
  }
  return { history, capacities, periodCaps };
}

function instant(value) {
  if (value == null || value === '') return null;
  const number = new Date(value).getTime();
  return Number.isFinite(number) ? number : null;
}
const lessonTime = row => instant(row.checkin_at) ?? instant(row.report_identity?.scheduled_at) ?? Infinity;
const countsAsLesson = row => Number(row.payroll_lesson_count ?? (row.checkin_status === 'checked_in' ? 1 : 0)) > 0;
// Owner 2026-10-20：舊家教系統移轉補進來的上課紀錄已在舊系統結算，只有在新系統簽到的才算薪資。
function settledInLegacySystem(row) {
  const attended = (row.checkin_details || []).filter(item => text(item.status || 'ATTENDED') === 'ATTENDED');
  return attended.length > 0 && attended.every(item => item.source === 'legacy_import');
}
function taipeiMinute(value) {
  const time = instant(value);
  if (time === null) return '時間未記錄';
  const iso = new Date(time + 28800000).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '/')} ${iso.slice(11, 16)}`;
}
function capacityOf(row, key, capacities) {
  const value = row.report_identity?.shared_purchase === true ? capacities.get(key)
    : Number(row.report_identity?.total_sessions);
  return Number.isInteger(value) && value > 0 ? value : null;
}

// 堂號：這一堂是第幾期的第幾堂（Owner 2026-10-13：每筆簽到要對得上第幾堂）。
// 共班依簽到先後先填滿前一期再用下一期；獨立一對一沿用課期自己的期號。超過購買堂數的沒有堂號。
function slotOf(row, sequence, periods) {
  const identity = row.report_identity || {};
  if (identity.shared_purchase !== true) {
    const total = Number(identity.total_sessions), number = Number(identity.period_number);
    if (!Number.isInteger(total) || sequence > total) return null;
    return { period: Number.isInteger(number) && number > 0 ? number : 1, seq: sequence };
  }
  let left = sequence;
  for (const [period, total] of periods || []) {
    if (left <= total) return { period, seq: left };
    left -= total;
  }
  return null;
}
function lessonNo(row, slot) {
  const shared = row.report_identity?.shared_purchase === true;
  const base = shared && text(row.transaction_no) ? text(row.transaction_no) + '-' + slot.period : text(row.transaction_period);
  return base ? base + '-' + slot.seq : null;
}

// lessons：mergeSessionRecords 的輸出（一列＝一堂）。inRange：這一堂是否在本次查詢要回傳的範圍內。
function numberLessons(lessons, capacities = new Map(), inRange = () => true, periodCaps = new Map()) {
  const classes = new Map();
  const unclassed = [];
  lessons.forEach((row, index) => {
    const key = classKey(row);
    if (!countsAsLesson(row)) return;
    if (!key) { unclassed.push(index); return; }
    if (!classes.has(key)) classes.set(key, []);
    classes.get(key).push(index);
  });
  const output = lessons.map(row => ({ ...row }));
  const markLegacySettled = (row) => {
    row.legacy_settled = true;
    row.payroll_lesson_count = 0;
    row.legacy_checkin_at = row.checkin_at;
    row.checkin_at = null;
  };
  for (const index of unclassed) if (settledInLegacySystem(output[index])) markLegacySettled(output[index]);
  for (const [key, indexes] of classes) {
    indexes.sort((a, b) => lessonTime(lessons[a]) - lessonTime(lessons[b])
      || text(lessons[a].id).localeCompare(text(lessons[b].id)));
    let lastCounted = null, lastCountedInRange = null;
    indexes.forEach((index, position) => {
      const row = output[index], sequence = position + 1;
      const capacity = capacityOf(row, key, capacities);
      row.lesson_seq = sequence;
      row.lesson_capacity = capacity;
      const slot = slotOf(row, sequence, periodCaps.get(key));
      row.lesson_period_number = slot ? slot.period : null;
      row.lesson_period_seq = slot ? slot.seq : null;
      row.lesson_no = slot ? lessonNo(row, slot) : null;
      // 舊系統的課照樣佔堂號與購買上限（新簽到才會接著編第幾堂、超過才擋得住），
      // 但不計教練堂數；清掉 checkin_at 的理由同下方超過購買堂數，原時間留在 legacy_checkin_at。
      // 舊系統本來就超用的也只標已結算，不標成新的超額簽到。
      if (settledInLegacySystem(row)) { markLegacySettled(row); return; }
      if (capacity === null || sequence <= capacity) {
        lastCounted = row;
        if (inRange(row)) lastCountedInRange = row;
        return;
      }
      // 超過購買堂數：保留原始簽到，但不計教練堂數。清掉 checkin_at 讓明細、總堂數表與
      // 樞紐三處共用的「有簽到時間才計堂」一致地排除這一列；原時間留在 over_cap_checkin_at。
      const note = `［超過購買堂數］本購買共 ${capacity} 堂已計滿；${taipeiMinute(row.checkin_at)} 另有簽到（${(row.students || []).join('、') || '學員未記錄'}），為第 ${sequence} 次，不計教練堂數。`;
      row.lesson_over_cap = true;
      row.payroll_lesson_count = 0;
      row.over_cap_checkin_at = row.checkin_at;
      row.checkin_at = null;
      row.lesson_cap_notes = [note];
      // 註記掛在同一班最後一堂有計的課；超過的那堂在本次範圍內時，優先掛在範圍內看得到的那一堂。
      const target = inRange(row) ? (lastCountedInRange || lastCounted) : lastCounted;
      if (target) target.lesson_cap_notes = [...(target.lesson_cap_notes || []), note];
    });
  }
  return output;
}

module.exports = { loadClassScope, numberLessons, classKey };
