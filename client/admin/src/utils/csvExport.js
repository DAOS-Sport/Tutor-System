import * as XLSX from 'xlsx';
import { buildSessionXlsxReport } from './sessionXlsxReport.mjs';
import { SESSION_HEADERS, sessionToRow } from './sessionReportRows.mjs';
import { hasSessionCheckin } from './sessionExportSummary.mjs';
export { SESSION_HEADERS, sessionToRow } from './sessionReportRows.mjs';
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
function checkedInExportRows(sessions, venueName) {
  const signedSessions = (sessions || []).filter(hasSessionCheckin);
  if (signedSessions.length === 0) {
    const error = new Error('查詢範圍沒有已簽到的上課紀錄可匯出');
    error.code = 'SESSION_EXPORT_NO_CHECKINS';
    throw error;
  }
  const rows = signedSessions.map((session) => sessionToRow(session, venueName));
  const checkinIndex = SESSION_HEADERS.indexOf('簽到時間');
  if (rows.some((row) => typeof row[checkinIndex] !== 'string' || row[checkinIndex].trim() === '')) {
    const error = new Error('簽到資料與匯出明細不一致，請重新查詢後再試');
    error.code = 'SESSION_EXPORT_DETAIL_RECONCILIATION_FAILED';
    throw error;
  }
  return { signedSessions, rows };
}

export function exportSessionsCsv({ filenamePrefix = 'sessions', sessions, venueName }) {
  const { rows } = checkedInExportRows(sessions, venueName);
  downloadCsv(`${filenamePrefix}_${todayISO()}.csv`, rowsToCsv(SESSION_HEADERS, rows));
}

export function exportSessionsXlsx({ filenamePrefix = 'sessions', sessions, venueName, venues, coefficientCategories, sheetName = '上課紀錄' }) {
  const { signedSessions, rows } = checkedInExportRows(sessions, venueName);
  const report = buildSessionXlsxReport(XLSX, {
    headers: SESSION_HEADERS,
    detailRows: rows,
    sessions: signedSessions,
    venueName,
    venues,
    coefficientCategories,
    sheetName,
  });
  const blob = new Blob([report.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${filenamePrefix}_${todayISO()}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return report.summary.counts;
}
