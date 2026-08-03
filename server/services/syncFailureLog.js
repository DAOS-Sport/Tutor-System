'use strict';
/**
 * 同步失敗落庫（Phase 1 可觀測性 / migration 040）
 *
 * 背景：backup 的 catch 只有 errors.push + console.warn，而 ragic_sync_log 僅保存
 * errors[0]。「144 筆失敗」在 DB 裡只剩第 1 筆訊息，其餘無法還原。本模組把每一筆
 * 失敗都寫進 ragic_sync_failures。
 *
 * 設計約束（本模組不得違反）：
 *   1. 純新增觀測，絕不改變同步行為——record() 自己吞掉所有錯誤，
 *      落庫失敗只印 warn，不得讓 backup 迴圈中斷或改變 errors 陣列。
 *   2. 不得寫入 PII。message 一律先過 sanitizeMessage()。
 *   3. classifyRagicError 是純函式，可單元測試，不碰 DB、不碰時鐘。
 */

// 逾時／5xx／網路類：重試有機會成功
const TRANSIENT_CODES = new Set([
  'RAGIC_TIMEOUT',
  'RAGIC_NETWORK_ERROR',
  'RAGIC_HTTP_SERVER_ERROR',
  'RAGIC_RETRY_EXHAUSTED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
]);

// 資料本身不合法：重試永遠失敗，這些才是 Phase 2 隔離的對象
const PERMANENT_CODES = new Set([
  'RAGIC_VALIDATION_ERROR',
  'RAGIC_APPLICATION_ERROR',
  'RAGIC_UID_FIELD_SCHEMA_MISMATCH',
  'RAGIC_UID_DUPLICATE',
  'RAGIC_HTTP_CLIENT_ERROR',
]);

/** Ragic 回「INVALID 202: 欄位 X 為必填」這類訊息 → 一定是資料問題，不是暫時性。 */
const PERMANENT_MESSAGE_RE = /INVALID\s+\d+|為必填|欄位.*不存在|not found|invalid field/i;

/**
 * 去識別化：訊息可能夾帶使用者資料，落庫前一律清掉。
 * 保留欄位名稱與錯誤碼（那是診斷所需，且非個資）。
 */
function sanitizeMessage(input, maxLen = 500) {
  let s = String(input ?? '');
  if (!s) return '';
  s = s
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')          // email
    .replace(/\b09\d{8}\b/g, '<phone>')                        // 台灣手機
    .replace(/\b0\d{1,2}-?\d{6,8}\b/g, '<phone>')              // 市話
    .replace(/\b[A-Z]\d{9}\b/g, '<id>')                        // 身分證
    .replace(/\bU[0-9a-f]{32}\b/gi, '<line_uid>');             // LINE UID
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/**
 * 錯誤分類（純函式）。
 * @returns {{ code: string|null, kind: 'permanent'|'transient'|'unknown', message: string }}
 */
function classifyRagicError(err) {
  const code = err?.code ? String(err.code) : null;
  const rawMessage = err?.message ?? String(err ?? '');
  const message = sanitizeMessage(rawMessage);

  // 重試耗盡時，真正的死因掛在 cause 上——用 cause 分類才有意義
  if (code === 'RAGIC_RETRY_EXHAUSTED' && err?.cause?.code) {
    const inner = classifyRagicError(err.cause);
    return { code, kind: inner.kind === 'unknown' ? 'transient' : inner.kind, message };
  }

  if (code && PERMANENT_CODES.has(code)) return { code, kind: 'permanent', message };
  if (code && TRANSIENT_CODES.has(code)) return { code, kind: 'transient', message };

  // Postgres 唯一鍵衝突：本地資料狀態問題，重試不會好
  if (code === '23505') return { code, kind: 'permanent', message };

  // 沒有 code 時退回訊息特徵（Ragic 應用層錯誤常只有 message）
  if (PERMANENT_MESSAGE_RE.test(rawMessage)) return { code, kind: 'permanent', message };

  return { code, kind: 'unknown', message };
}

/**
 * 落庫（薄包裝）。best-effort：任何失敗都只印 warn，絕不往外拋。
 * 呼叫端在 catch 內使用，不得因為這行而改變原本的錯誤處理路徑。
 */
async function record(db, {
  jobName, formCode, entityKind, localId, ragicRecordId, error, runId,
}) {
  try {
    const c = classifyRagicError(error);
    await db.query(
      `INSERT INTO ragic_sync_failures
         (job_name, form_code, entity_kind, local_id, ragic_record_id, error_code, error_kind, message, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [jobName, formCode || null, entityKind, localId,
        ragicRecordId ? String(ragicRecordId) : null,
        c.code, c.kind, c.message, runId || null]
    );
  } catch (e) {
    // 觀測失敗不得影響同步本身
    console.warn('[sync-failure-log] 落庫失敗（不影響同步）:', e.message);
  }
}

module.exports = { classifyRagicError, sanitizeMessage, record, TRANSIENT_CODES, PERMANENT_CODES };