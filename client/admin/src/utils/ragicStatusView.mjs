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

// Ragic 打進來的請求結果（ragic_webhook_attempts.outcome）→ 白話
export const ATTEMPT_OUTCOMES = {
  ok:                 { tone: 'green', text: '成功', rejected: false },
  unavailable:        { tone: 'amber', text: '暫時失敗，會自動重試', rejected: false },
  unauthorized:       { tone: 'red',   text: '被拒：網址裡的密碼不符', rejected: true },
  invalid_payload:    { tone: 'red',   text: '被拒：內容看不懂', rejected: true },
  method_not_allowed: { tone: 'red',   text: '被拒：不是用 POST 送的', rejected: true },
};

export function attemptOutcome(outcome) {
  return ATTEMPT_OUTCOMES[outcome] || { tone: 'gray', text: '其他', rejected: false };
}

