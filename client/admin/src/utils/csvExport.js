import {
  formatTWDateTime,
  courseTypeLabel,
  paymentStatusLabel,
  todayISO,
} from './format';

function escapeCell(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const r of rows) lines.push(r.map(escapeCell).join(','));
  return lines.join('\r\n');
}

export function downloadCsv(filename, csv) {
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function findReconcileLog(enrollment) {
  if (!enrollment?.audit_logs) return null;
  return enrollment.audit_logs.find((a) => a.action && a.action.indexOf('對帳通過') !== -1) || null;
}

const ENROLLMENT_HEADERS = [
  '報名編號',
  '送出時間',
  '家長姓名',
  '家長手機',
  '學員',
  '教練',
  '場館',
  '組別',
  '原價',
  '應收',
  '轉帳末 5 碼',
  '狀態',
  '對帳通過時間',
  '對帳人',
];

export function enrollmentToRow(e, venueName) {
  const reconcileLog = findReconcileLog(e);
  return [
    e.id,
    formatTWDateTime(e.submitted_at),
    e.parent_name,
    e.parent_phone,
    (e.students || []).join('、'),
    e.coach,
    venueName(e.venue_id),
    courseTypeLabel(e.course_type),
    e.original_price ?? '',
    e.final_price ?? '',
    e.transfer_last_5 || '',
    paymentStatusLabel(e.status),
    reconcileLog ? formatTWDateTime(reconcileLog.at) : '',
    reconcileLog ? reconcileLog.by : '',
  ];
}

export function exportEnrollmentsCsv({ filenamePrefix, enrollments, venueName }) {
  const rows = enrollments.map((e) => enrollmentToRow(e, venueName));
  const csv = rowsToCsv(ENROLLMENT_HEADERS, rows);
  downloadCsv(`${filenamePrefix}_${todayISO()}.csv`, csv);
}
