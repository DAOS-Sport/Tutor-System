'use strict';

// Read-side FR01 normalization; never updates attendance, deductions or balances.
const text = value => value == null ? '' : String(value).trim();
const MANUAL_SPLIT_WINDOW_MS = 30 * 60 * 1000;
function instant(value) {
  if (value == null || value === '') return null;
  if (!(value instanceof Date) && !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(String(value))) return null;
  const number = new Date(value).getTime();
  return Number.isFinite(number) ? number : null;
}
function day(value) {
  if (value instanceof Date) return new Date(value.getTime()+28800000).toISOString().slice(0,10);
  const result = text(value);
  return /^\d{4}-\d\d-\d\d$/.test(result) ? result : '';
}
const isManualDeduction = row => Boolean(row.deduction_reason || row.deduction_status || row.deducted_at);
function identityKey(row) {
  const identity = row.report_identity;
  if (!identity || !text(identity.period_id) || !text(identity.coach_id) || !text(row.venue_id)) return null;
  const number = Number(identity.period_number), duration = Number(identity.duration_minutes);
  const courseType = Number(row.course_type);
  if (!Number.isInteger(number) || number < 1 || !Number.isInteger(duration) || duration < 1
      || !Number.isInteger(courseType) || courseType < 1) return null;
  const purchase = text(identity.purchase_id);
  if (!purchase || !['batch','group','order','period'].includes(identity.purchase_kind)) return null;
  const date = day(row.date), scheduled = instant(identity.scheduled_at);
  if (!date || scheduled === null) return null;
  const scheduledDay = new Date(scheduled+28800000).toISOString().slice(0,10);
  if (scheduledDay !== date) return null;
  const shared = identity.shared_purchase === true;
  let lesson;
  if (identity.created_via === 'self_checkin') {
    // The existing self-checkin contract permits one class per purchase/period/day.
    // It has no booked start time: individual sign-in instants must not split it.
    if (day(identity.self_checkin_date) !== date) return null;
    lesson = ['self', date];
  } else if (identity.created_via === 'booking') {
    // 櫃檯手動扣課沒有預約時段；共班被拆成各學員課期分開扣時，同日的拆筆要能落在同一桶，
    // 再由 normalizeClassGroup 用「不同課期、不同學員、30 分鐘內」判定是否同一堂。
    lesson = !text(identity.availability_slot_id) && shared && isManualDeduction(row)
      ? ['manual', date] : ['booking', text(identity.availability_slot_id) || scheduled];
  } else return null;
  // Independent one-to-one orders can share a checkout batch. Keep their real
  // period IDs in the key unless the stored group/config proves a shared class.
  const classPurchase = shared ? purchase : text(identity.period_id);
  // Owner 2026-10-12：同一購買、同一教練、同一天的共班只算一堂，不論各學員簽在哪一個期號。
  // 期號只在預約時段（單一課堂）與獨立一對一訂單保留在鍵裡。
  const keyNumber = shared && lesson[0] !== 'booking' ? 0 : number;
  return JSON.stringify([identity.purchase_kind,purchase,classPurchase,keyNumber,text(row.venue_id),text(identity.coach_id),
    courseType,Boolean(row.is_experience_course),duration,date,...lesson]);
}
const lessonKind = key => { try { return JSON.parse(key).slice(-2)[0]; } catch { return null; } };
function attendeeRefs(row) {
  const refs = new Map();
  for (const item of row.report_identity?.students || []) {
    if (text(item.id) && text(item.name)) refs.set(text(item.id), { id: text(item.id), name: text(item.name) });
  }
  for (const item of row.checkin_details || []) {
    if (text(item.student_id) && text(item.student)) refs.set(text(item.student_id), { id: text(item.student_id), name: text(item.student) });
  }
  return [...refs.values()];
}
function attendanceKey(detail) {
  return text(detail.id) || JSON.stringify([detail.session_id,detail.student_id,detail.student,detail.source,
    detail.by,detail.at,detail.status,detail.reversal_reason]);
}
function normalizedRow(row) {
  const identity = row.report_identity || {};
  const purchase = text(identity.purchase_id);
  const number = Number(identity.period_number);
  const ids = row.merged_session_ids || [row.id];
  const deductions = row.deduction_details || (row.deduction_reason || row.deduction_status ? [{
    session_id: row.id, reason: row.deduction_reason || null, by: row.deducted_by || null,
    at: row.deducted_at || null, status: row.deduction_status || null, reversal_reason: row.deduction_reversal_reason || null,
  }] : []);
  return { ...row,
    transaction_no: identity.purchase_kind === 'period' ? '' : purchase,
    transaction_period: identity.purchase_kind === 'period' ? text(identity.period_id)
      : purchase && Number.isInteger(number) && number > 0 ? `${purchase}-${number}` : text(identity.period_id),
    merged_session_ids: [...new Set(ids.map(text).filter(Boolean))].sort(),
    merged_period_ids: [...new Set((row.merged_period_ids || [identity.period_id]).map(text).filter(Boolean))].sort(),
    deduction_details: deductions.map(item => ({...item})),
    checkin_details: (row.checkin_details || []).map(item => ({ ...item, session_id: item.session_id || row.id })),
  };
}
function mergeGroup(group) {
  const rows = group.map(normalizedRow);
  if (rows.length === 1) return rows[0];
  const order = [...rows].sort((a,b) => (instant(a.report_identity?.scheduled_at) ?? Infinity)
    -(instant(b.report_identity?.scheduled_at) ?? Infinity) || text(a.id).localeCompare(text(b.id)));
  const representative = order[0];
  const refs = new Map(), details = new Map(), deductions = new Map();
  for (const row of rows) {
    for (const item of attendeeRefs(row)) refs.set(item.id,item);
    for (const item of row.checkin_details) details.set(attendanceKey(item),item);
    for (const item of row.deduction_details) deductions.set(JSON.stringify([item.session_id,item.at,item.reason,item.status]),item);
  }
  const checkins = [...details.values()].sort((a,b) => (instant(a.at) ?? Infinity)-(instant(b.at) ?? Infinity)
    || attendanceKey(a).localeCompare(attendanceKey(b)));
  const times = rows.map(row => instant(row.checkin_at)).filter(value => value !== null);
  for (const detail of checkins) if (detail.status === 'ATTENDED' && instant(detail.at) !== null) times.push(instant(detail.at));
  const first = times.length ? Math.min(...times) : null;
  const multipliers = rows.map(row => row.coach_pricing_multiplier == null ? null : Number(row.coach_pricing_multiplier));
  const coefficientValid = multipliers.every(value => Number.isFinite(value) && value > 0 && value === multipliers[0]);
  const students = [...refs.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-Hant') || a.id.localeCompare(b.id));
  const result = { ...representative,
    report_identity: { ...representative.report_identity, students },
    students: students.map(item => item.name), checkin_details: checkins,
    deduction_details: [...deductions.values()],
    merged_session_ids: [...new Set(rows.flatMap(row => row.merged_session_ids))].sort(),
    merged_period_ids: [...new Set(rows.flatMap(row => row.merged_period_ids))].sort(),
    merge_method: representative.report_identity.created_via === 'self_checkin' ? 'purchase_period_self_day' : 'purchase_period_booked_slot',
    checkin_at: first === null ? null : new Date(first),
    checkin_status: first !== null ? 'checked_in' : representative.checkin_status,
    coach_pricing_multiplier: coefficientValid ? multipliers[0] : null,
  };
  if (!coefficientValid) {
    result.coefficient_classification_reason = 'merge_purchase_coefficient_conflict';
    result.coefficient_classification_source = null;
  }
  return result;
}
function sessionRows(group) {
  // Repeated JOIN rows are one actual session.
  const sessions = new Map();
  for (const [index,row] of group.entries()) {
    const key = text(row.id) || `missing:${index}`;
    if (!sessions.has(key)) sessions.set(key,[]);
    sessions.get(key).push(row);
  }
  return [...sessions.values()].map(mergeGroup);
}
function splitManualClasses(rows) {
  // 櫃檯手動扣課：同課期的多筆是刻意補扣，各算一堂。只有「不同課期、不同學員、
  // 30 分鐘內」的拆筆才視為同一堂共班（Owner 2026-10-12）。
  const order = [...rows].sort((a,b) => (instant(a.report_identity?.scheduled_at) ?? Infinity)
    -(instant(b.report_identity?.scheduled_at) ?? Infinity) || text(a.id).localeCompare(text(b.id)));
  const clusters = [];
  for (const row of order) {
    const refs = attendeeRefs(row), at = instant(row.report_identity?.scheduled_at);
    const target = refs.length && at !== null ? clusters.find(cluster => at - cluster.start <= MANUAL_SPLIT_WINDOW_MS
      && row.merged_period_ids.every(id => !cluster.periods.has(id))
      && refs.every(ref => !cluster.students.has(ref.id))) : null;
    const cluster = target || { start: at ?? 0, periods: new Set(), students: new Set(), rows: [] };
    if (!target) clusters.push(cluster);
    cluster.rows.push(row);
    for (const id of row.merged_period_ids) cluster.periods.add(id);
    for (const ref of refs) cluster.students.add(ref.id);
  }
  return clusters.map(cluster => cluster.rows.length > 1
    ? { ...mergeGroup(cluster.rows), merge_method: 'purchase_day_manual_split' } : cluster.rows[0]);
}
function normalizeClassGroup(group, key) {
  // Distinct session IDs on an already-shared period can be real extra lessons,
  // even at the same time.
  const rows = sessionRows(group);
  if (rows.length < 2) return rows;
  const kind = lessonKind(key);
  if (kind === 'self') {
    // Owner 2026-10-12：家長自助簽到，同一購買、同一教練、同一天只算一堂；
    // 兄弟姊妹各簽各的、簽在不同期號都屬同一堂。原始簽到明細全部保留在 checkin_details。
    return [{ ...mergeGroup(rows), merge_method: 'purchase_day_parent_self' }];
  }
  if (kind === 'manual') return splitManualClasses(rows);
  const periods = new Set(), students = new Set(), originals = new Set();
  for (const row of rows) {
    const refs = attendeeRefs(row);
    if (!row.merged_period_ids.length || !row.merged_session_ids.length || !refs.length) return rows;
    for (const id of row.merged_period_ids) {
      if (periods.has(id)) return rows;
      periods.add(id);
    }
    for (const id of row.merged_session_ids) {
      if (originals.has(id)) return rows;
      originals.add(id);
    }
    for (const ref of refs) {
      if (students.has(ref.id)) return rows;
      students.add(ref.id);
    }
  }
  // Only disjoint historical individual periods can form one shared class.
  // An ambiguous bucket is kept whole; never guess which lessons to combine.
  return [mergeGroup(rows)];
}
function mergeSessionRecords(rows) {
  const groups = new Map();
  const stored = new Map();
  const rest = [];
  for (const [index,row] of rows.entries()) {
    const canonical = row.canonical_lesson;
    if (canonical) {
      if (canonical.source_valid !== true || canonical.policy !== 'WHOLE_CLASS_ANY_ATTENDED_V1'
          || !text(canonical.id) || !(canonical.roster?.length > 1)
          || !canonical.source_session_ids?.includes(row.id)) {
        throw new Error('canonical_lesson_source_conflict');
      }
      if (!stored.has(canonical.id)) stored.set(canonical.id,[]);
      stored.get(canonical.id).push(row);
      continue;
    }
    rest.push([index,row]);
  }
  // 已永久整併的家長自助課堂：同一購買同日、但簽在別的期號的家長簽到要併進同一堂，
  // 否則較早被單獨簽的那筆會在整班核消之外再被算一堂。
  const storedByDay = new Map(), extras = new Map();
  for (const [id,group] of stored) {
    const keys = new Set(group.map(identityKey));
    const key = keys.size === 1 ? [...keys][0] : null;
    if (key && lessonKind(key) === 'self') storedByDay.set(key, storedByDay.has(key) ? null : id);
  }
  for (const [index,row] of rest) {
    // No identity-based guess from names, phone numbers or near-by timestamps.
    const key = attendeeRefs(row).length ? identityKey(row) : null;
    const canonicalId = key ? storedByDay.get(key) : null;
    if (canonicalId) {
      if (!extras.has(canonicalId)) extras.set(canonicalId,[]);
      extras.get(canonicalId).push(row);
      continue;
    }
    const resolved = key || `unresolved:${index}`;
    if (!groups.has(resolved)) groups.set(resolved,[]);
    groups.get(resolved).push(row);
  }
  const corrected = [...stored.entries()].map(([id,group])=>{
    const canonical = group[0].canonical_lesson;
    const contract = JSON.stringify(canonical);
    if (group.some(row=>JSON.stringify(row.canonical_lesson)!==contract)) throw new Error('canonical_lesson_source_conflict');
    const added = sessionRows(extras.get(id) || []);
    const result = mergeGroup(group.concat(added));
    const refs = new Map(canonical.roster.map(item=>[item.id,item]));
    for (const row of added) for (const ref of attendeeRefs(row)) refs.set(ref.id,ref);
    const roster = [...refs.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-Hant') || a.id.localeCompare(b.id));
    const addedTimes = added.filter(row=>row.checkin_status==='checked_in').map(row=>instant(row.checkin_at)).filter(value=>value!==null);
    const consumed = canonical.consumed === true || addedTimes.length > 0;
    const canonicalAt = canonical.consumed ? instant(canonical.checkin_at) ?? instant(result.checkin_at) : null;
    const times = [canonicalAt,...addedTimes].filter(value=>value!==null);
    return {...result,canonical_lesson_id:canonical.id,whole_class_consumed:consumed,
      payroll_lesson_count:consumed?1:0,whole_class_policy:canonical.policy,
      merge_method:added.length?'stored_canonical_lesson_purchase_day':'stored_canonical_lesson',students:roster.map(item=>item.name),
      report_identity:{...result.report_identity,students:roster},
      checkin_status:consumed?'checked_in':'not_yet',
      checkin_at:!consumed?null:!added.length?(canonical.checkin_at || result.checkin_at)
        :(times.length?new Date(Math.min(...times)):result.checkin_at),
    };
  });
  return [...groups.entries()].flatMap(([key,group])=>normalizeClassGroup(group,key)).concat(corrected);
}
module.exports = { mergeSessionRecords };
