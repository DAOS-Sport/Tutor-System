// Ragic 狀態頁的判斷邏輯（純函式，tests/ragic_status_page_test.js 直接 import 驗證）。

// 寫不進 Ragic 的原因代碼 → 櫃台看得懂的說法
export const FAILURE_REASONS = {
  STUDENT_ID_NUMBER_EXISTS: '身分證和其他帳號的學員重複（多半是同一家人各登記一次）',
  RAGIC_VALIDATION_ERROR: '缺生日、身分證等必填資料',
};

export function reasonText(code) {
  return FAILURE_REASONS[code] || '其他資料問題';
}

// sync-failures 的 by_job_code → { [job]: { permanent, transient, reasons[] } }
// permanent＝資料本身要修，重試永遠不會過；transient＝連線等暫時問題，下次會再試。
export function summarizeFailures(failures) {
  const byJob = {};
  for (const row of failures?.by_job_code || []) {
    const job = row.job_name || 'unknown';
    const entry = byJob[job] || (byJob[job] = { permanent: 0, transient: 0, reasons: [] });
    const count = row.distinct_records || 0;
    if (row.error_kind === 'permanent') {
      entry.permanent += count;
      entry.reasons.push({ code: row.error_code, count });
    } else {
      entry.transient += count;
    }
  }
  return byJob;
}

// 一個工作現在的狀態（徽章與總覽共用）
export function jobState(info, issues) {
  if (info.in_progress) return { key: 'running', tone: 'teal', text: '執行中…' };
  if (info.admin_enabled === false) return { key: 'paused', tone: 'gray', text: '已暫停' };
  if (info.last_status === 'ok') return { key: 'ok', tone: 'green', text: '正常' };
  if (info.last_status === 'error' && issues && issues.permanent > 0 && issues.transient === 0) {
    // 例：每晚寫回 Ragic。大部分資料照常寫回，只有個別學員資料不完整 → 不是整個壞掉
    return { key: 'partial', tone: 'amber', text: '部分完成' };
  }
  if (info.last_status === 'error') return { key: 'error', tone: 'red', text: '失敗' };
  if (info.last_status === 'stale_read') return { key: 'error', tone: 'red', text: '讀到舊資料' };
  if (info.last_status === 'skipped') return { key: 'skipped', tone: 'gray', text: '未執行' };
  return { key: 'none', tone: 'gray', text: '尚無紀錄' };
}

// '30 2 * * *' → 150（分鐘）；不是「每天固定時間」的格式回 null
export function cronToMinutes(cron) {
  const m = /^(\d+) (\d+) \* \* \*$/.exec(cron || '');
  return m ? Number(m[2]) * 60 + Number(m[1]) : null;
}

export function hhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// 說明區的時間軸：每天固定時間的排程依時間排序，同一時間合併；其他（如每分鐘）另列
export function buildTimeline(schedules) {
  const entries = [...(schedules?.background || []), ...Object.values(schedules?.jobs || {})];
  const byTime = new Map();
  for (const s of entries) {
    const minutes = cronToMinutes(s.cron);
    if (minutes == null) continue;
    if (!byTime.has(minutes)) byTime.set(minutes, []);
    byTime.get(minutes).push(s.name);
  }
  return {
    daily: [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([minutes, names]) => ({ time: hhmm(minutes), names })),
    frequent: entries.filter((s) => s.cron && cronToMinutes(s.cron) == null),
  };
}
