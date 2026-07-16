import * as XLSX from 'xlsx';
import {
  formatTWDateTime,
  courseTypeLabel,
  paymentStatusLabel,
  checkinStatusLabel,
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

// === XLSX (SheetJS) =========================================================
// 直接以 aoa_to_sheet → writeFile 觸發瀏覽器下載；filename 需含 .xlsx。
export function downloadXlsx(filename, headers, rows, sheetName = 'Sheet1') {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

// === Enrollments 共用列定義 =================================================
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
  '訂單類型',
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
    e.order_kind === 'trial' ? '試上' : '一般',
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

export function exportEnrollmentsXlsx({ filenamePrefix, enrollments, venueName, sheetName = '報名資料' }) {
  const rows = enrollments.map((e) => enrollmentToRow(e, venueName));
  downloadXlsx(`${filenamePrefix}_${todayISO()}.xlsx`, ENROLLMENT_HEADERS, rows, sheetName);
}

// === 上課紀錄（sessions）共用列定義 =========================================
export const SESSION_HEADERS = ['日期', '時間', '場館', '教練', '組別', '學員', '簽到狀態'];

export function sessionToRow(s, venueName) {
  return [
    s.date,
    `${s.start} – ${s.end}`,
    venueName ? venueName(s.venue_id) : s.venue_id,
    s.coach,
    courseTypeLabel(s.course_type),
    (s.students || []).join('、'),
    checkinStatusLabel(s.checkin_status),
  ];
}

export function exportSessionsCsv({ filenamePrefix = 'sessions', sessions, venueName }) {
  const rows = sessions.map((s) => sessionToRow(s, venueName));
  downloadCsv(`${filenamePrefix}_${todayISO()}.csv`, rowsToCsv(SESSION_HEADERS, rows));
}

export function exportSessionsXlsx({ filenamePrefix = 'sessions', sessions, venueName, sheetName = '上課紀錄' }) {
  const rows = sessions.map((s) => sessionToRow(s, venueName));
  downloadXlsx(`${filenamePrefix}_${todayISO()}.xlsx`, SESSION_HEADERS, rows, sheetName);
}
