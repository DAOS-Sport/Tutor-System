import * as XLSX from 'xlsx';
import { buildSessionXlsxReport } from './sessionXlsxReport.mjs';
import { SESSION_HEADERS, sessionToRow } from './sessionReportRows.mjs';
import { hasSessionCheckin } from './sessionExportSummary.mjs';
export { SESSION_HEADERS, sessionToRow } from './sessionReportRows.mjs';
import { todayISO } from './format';
import { rowsToCsv, downloadCsv } from './tableExport';

// 上課紀錄匯出。上課紀錄頁（凍結範圍）同步使用 exportSessionsXlsx 的回傳值，所以 xlsx 在這裡
// 靜態載入；其他頁面的匯出改用 tableExport.js（xlsx 點擊時才載入）。

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
