import { buildSessionSummary, hasSessionCheckin, sessionPivotCategory } from './sessionExportSummary.mjs';
import { addSessionPivot } from './sessionPivotXlsx.mjs';
import { SESSION_HEADERS } from './sessionReportRows.mjs';

const PIVOT_SHEET = '總堂數表';

function excelColumn(index) {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export function buildSessionXlsxReport(XLSX, {
  headers,
  detailRows,
  sessions,
  venueName,
  venues,
  coefficientCategories,
  sheetName = '上課紀錄',
}) {
  if (JSON.stringify(headers) !== JSON.stringify(SESSION_HEADERS) || detailRows.length !== sessions.length
      || detailRows.some(row => row.length !== headers.length)) throw new Error('SESSION_XLSX_DETAIL_SCHEMA');
  const checkinIndex = headers.indexOf('簽到時間');
  if (detailRows.some((row, index) => (typeof row[checkinIndex] === 'string' && row[checkinIndex].trim() !== '') !== hasSessionCheckin(sessions[index]))) {
    const error = new Error('匯出明細的簽到資料與總堂數不一致，請重新查詢後再試');
    error.code = 'SESSION_EXPORT_DETAIL_RECONCILIATION_FAILED';
    throw error;
  }
  // A check-in report shares one signed-only dataset across both worksheets and
  // the native pivot cache. Keep unsigned lessons in the query/database only.
  const signedEntries = sessions.flatMap((session, index) => hasSessionCheckin(session)
    ? [{ session, detail: detailRows[index] }] : []);
  const signedSessions = signedEntries.map(({ session }) => session);
  const summary = buildSessionSummary(signedSessions, venueName, { venues, coefficientCategories });
  const pivotColumns = summary.columns.map((column) => column.label);
  // One coach row can contain different purchased tiers. The tier is its own
  // numeric field; coach names never include the purchased percentage.
  const pivotHeaders = [...headers, '修課係數', '場館×係數分類', '教練彙總鍵'];
  const pivotRecords = signedEntries.map(({ session, detail: inputRow }) => {
    const detail = [...inputRow];
    const multiplier = Number(session.coach_pricing_multiplier);
    const coach = String(session.coach || '未指定教練');
    detail[headers.indexOf('教練')] = coach;
    return [...detail, multiplier, sessionPivotCategory(session, venueName, venues, coefficientCategories), coach];
  });

  const workbook = XLSX.utils.book_new();
  const detailSheet = XLSX.utils.aoa_to_sheet([pivotHeaders, ...pivotRecords]);
  // Dates are string cells, not Excel serials. Individual sign-ins wrap in the
  // note cell, while purchased coefficients remain numeric percentages.
  detailSheet['!cols'] = Array.from({ length: headers.length }, () => ({ wch: 16 }));
  detailSheet['!cols'][headers.indexOf('交易序號')] = { wch: 38 };
  detailSheet['!cols'][headers.indexOf('堂號')] = { wch: 44 };
  detailSheet['!cols'][headers.indexOf('學員')] = { wch: 28 };
  detailSheet['!cols'][headers.indexOf('簽到時間')] = { wch: 28 };
  detailSheet['!cols'][headers.indexOf('備註')] = { wch: 80 };
  detailSheet['!cols'].push({ wch: 18 }, { hidden: true }, { hidden: true });
  signedSessions.forEach((session, index) => {
    const date = detailSheet[`${excelColumn(headers.indexOf('日期'))}${index + 2}`];
    if (date) { date.t = 's'; date.z = '@'; }
    const cell = detailSheet[`${excelColumn(headers.length)}${index + 2}`];
    if (cell?.t === 'n') cell.z = '0%';
  });
  XLSX.utils.book_append_sheet(workbook, detailSheet, sheetName);

  const summaryRows = [
    ['計數 - 簽到時間', '欄標籤'],
    summary.headers,
    ...summary.rows,
    summary.totals,
  ];
  // The summary sheet holds only the pivot area (Owner 2026-10-13: no audit block).
  // Detail and summary still reconcile in code: the checks above and buildSessionSummary throw on any mismatch.
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [{ wch: 32 }, ...pivotColumns.map(() => ({ wch: 18 })), { wch: 12 }];
  XLSX.utils.book_append_sheet(workbook, summarySheet, PIVOT_SHEET);

  const sourceRange = `A1:${excelColumn(pivotHeaders.length-1)}${pivotRecords.length + 1}`;
  const summaryRange = `A1:${excelColumn(summary.headers.length - 1)}${summaryRows.length}`;
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return {
    bytes: addSessionPivot(XLSX, bytes, {
      headers: pivotHeaders,
      records: pivotRecords,
      sourceSheet: sheetName,
      sourceRange,
      coaches: summary.rows.map((row) => row[0]),
      columns: pivotColumns,
      summaryRange,
      rowFieldIndex: pivotHeaders.indexOf('教練彙總鍵'),
      columnFieldIndex: pivotHeaders.indexOf('場館×係數分類'),
      dataFieldIndex: pivotHeaders.indexOf('簽到時間'),
      dateFieldIndex: pivotHeaders.indexOf('日期'),
      noteFieldIndex: pivotHeaders.indexOf('備註'),
    }),
    summary,
    pivotHeaders,
    pivotRecords,
    sheetNames: [sheetName, PIVOT_SHEET],
  };
}
