// 表格匯出（CSV／XLSX）。xlsx 函式庫約 150 KB gzip，只在真的按下「匯出 XLSX」時才下載，
// 所以這裡的 XLSX 匯出都是 async。
//
// csvExport.js 仍保留同步版本給上課紀錄頁（屬凍結範圍，同步使用匯出結果），
// 共用的列定義與 CSV 邏輯都在這裡，兩邊只有「xlsx 何時載入」不同。
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
  const BOM = '﻿';
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

// 以 aoa_to_sheet → writeFile 觸發瀏覽器下載；filename 需含 .xlsx。
export function writeXlsxFile(XLSX, filename, headers, rows, sheetName = 'Sheet1') {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

export async function downloadXlsx(filename, headers, rows, sheetName = 'Sheet1') {
  const XLSX = await import('xlsx');
  writeXlsxFile(XLSX, filename, headers, rows, sheetName);
}

// === Enrollments 共用列定義 =================================================
function findReconcileLog(enrollment) {
  if (!enrollment?.audit_logs) return null;
  return enrollment.audit_logs.find((a) => a.action && a.action.indexOf('對帳通過') !== -1) || null;
}

export const ENROLLMENT_HEADERS = [
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
  downloadCsv(`${filenamePrefix}_${todayISO()}.csv`, rowsToCsv(ENROLLMENT_HEADERS, rows));
}

export async function exportEnrollmentsXlsx({ filenamePrefix, enrollments, venueName, sheetName = '報名資料' }) {
  const rows = enrollments.map((e) => enrollmentToRow(e, venueName));
  await downloadXlsx(`${filenamePrefix}_${todayISO()}.xlsx`, ENROLLMENT_HEADERS, rows, sheetName);
}
