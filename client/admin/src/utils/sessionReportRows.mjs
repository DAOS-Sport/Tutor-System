import { courseTypeLabel, checkinSourceLabel } from './format.js';

export const SESSION_HEADERS = ['交易序號','時間','堂號','日期','場館','教練','組別','學員','簽到時間','備註'];
const sourceLabel = source => source === 'staff' ? '櫃檯手動' : checkinSourceLabel(source);
function reportTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('簽到時間格式有誤，請重新查詢後再匯出');
  const parts = new Intl.DateTimeFormat('zh-TW', { timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).formatToParts(date);
  const part = key => parts.find(item => item.type === key).value;
  const weekday = new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',weekday:'short'}).format(date);
  return `${part('year')}/${part('month')}/${part('day')}（${weekday}）${part('hour')}:${part('minute')}:${part('second')}`;
}
// 備註每一行：日期（週X）｜來源｜ 時:分-內容（Owner 2026-10-13 指定格式）。
function noteLine(source, at, text) {
  if (!at) return '時間未記錄｜' + source + '｜ ' + text;
  const stamp = reportTime(at), cut = stamp.indexOf('）') + 1;
  return stamp.slice(0, cut) + '｜' + source + '｜ ' + stamp.slice(cut, cut + 5) + '-' + text;
}
function deductionsOf(session) {
  if (session.deduction_details?.length) return session.deduction_details;
  return session.deduction_reason || session.deduction_status ? [{
    session_id: session.id, reason: session.deduction_reason, by: session.deducted_by,
    at: session.deducted_at, status: session.deduction_status, reversal_reason: session.deduction_reversal_reason,
  }] : [];
}
export function sessionReportNote(session) {
  const deductions = deductionsOf(session);
  const checkins = Array.isArray(session.checkin_details) ? session.checkin_details : [];
  const seen = new Set();
  const signed = checkins.flatMap(detail => {
    const matching = deductions.find(item => item.session_id === detail.session_id);
    const by = detail.by || (detail.source === 'staff' ? matching?.by || '櫃檯人員' : '未記錄簽到者');
    const status = detail.status === 'REVERSED' ? `已註銷${detail.reversal_reason ? `：${detail.reversal_reason}` : ''}`
      : detail.status && detail.status !== 'ATTENDED' ? `狀態：${detail.status}` : '簽到';
    const source = sourceLabel(detail.source);
    const text = (detail.student || '學員未記錄') + ' 由 ' + by + ' ' + status;
    // 同一筆簽到（時間到秒、內容都相同）只列一次；同一分鐘內的不同筆仍各列一行。
    const key = source + '|' + (detail.at ? reportTime(detail.at) : '') + '|' + text;
    if (seen.has(key)) return [];
    seen.add(key);
    return [noteLine(source, detail.at, text)];
  });
  // 簽到行已在上面依原始時間去重；其餘各行沿用整行去重。
  const lines = [signed];
  if (session.coefficient_classification_source === 'manual_lesson_snapshot') {
    const chosen = Number(session.coach_pricing_multiplier);
    const original = session.coach_original_pricing_multiplier == null ? null : Number(session.coach_original_pricing_multiplier);
    if (Number.isFinite(chosen) && chosen > 0) lines.push(`［本堂修課係數］${chosen.toFixed(2)}（${Math.round(chosen * 100)}%）${Number.isFinite(original) && original > 0 ? `；教練原係數 ${original.toFixed(2)}（${Math.round(original * 100)}%）` : ''}`);
  }
  // 第幾堂看「堂號」欄，備註不再重複列堂次；超過購買堂數的簽到由後端附註，不另計教練堂數。
  for (const text of session.lesson_cap_notes || []) lines.push(text);
  if (session.whole_class_consumed && session.whole_class_policy) {
    lines.unshift('［整班核消］依原報名名單，全班核消，教練核薪計 1 堂；以下保留原始簽到操作。');
  }
  if (checkins.some(detail => detail.source === 'legacy_import')) {
    lines.unshift('［舊系統轉移］本堂為舊家教系統（ABLEPOS）移轉的上課紀錄，已於舊系統結算，不計教練堂數。');
  }
  for (const detail of deductions) {
    if (detail.reason) lines.push(noteLine('櫃檯手動', detail.at, '手動扣課：' + detail.reason + (detail.by ? '（' + detail.by + '）' : '')));
    if (detail.status === 'REVERSED') lines.push(`［櫃檯手動］已退回${detail.reversal_reason ? `：${detail.reversal_reason}` : ''}`);
    else if (detail.status && detail.status !== 'APPLIED') lines.push(`［櫃檯手動］扣課狀態：${detail.status}`);
  }
  return [...new Set(lines)].flat().join('\n');
}
export function sessionToRow(session,venueName) {
  const date = String(session.date || '');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) {
    throw new Error('上課日期格式有誤，請重新查詢後再匯出');
  }
  return [session.transaction_no || '',`${session.start || ''}－${session.end || ''}`,session.lesson_no || session.transaction_period || '',date,
    venueName ? venueName(session.venue_id) : session.venue_id,
    session.coach,courseTypeLabel(session.course_type),(session.students || []).join('、'),
    session.checkin_at ? reportTime(session.checkin_at) : '',sessionReportNote(session)];
}
