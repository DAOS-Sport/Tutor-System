'use strict';
// 同步失敗落庫 — 分類與去識別化的單元測試（零外部相依）
const assert = require('assert');
const { classifyRagicError, sanitizeMessage } = require('../server/services/syncFailureLog');

// ── 去識別化：不得洩漏個資 ──
assert.strictEqual(sanitizeMessage('聯絡 poyu@gmail.com 補資料'), '聯絡 <email> 補資料');
assert.strictEqual(sanitizeMessage('手機 0956736161 有誤'), '手機 <phone> 有誤');
assert.strictEqual(sanitizeMessage('市話 02-27001234'), '市話 <phone>');
assert.strictEqual(sanitizeMessage('身分證 A123456789'), '身分證 <id>');
assert.strictEqual(sanitizeMessage('uid Ufd5b5ffdc9e72df19862f1b3f823747a'), 'uid <line_uid>');
assert.strictEqual(sanitizeMessage(''), '');
assert.strictEqual(sanitizeMessage(null), '');
// 欄位名稱與錯誤碼必須保留（那是診斷所需，非個資）
assert.ok(sanitizeMessage('Ragic INVALID 202: 欄位 (報)Email 為必填').includes('(報)Email 為必填'));
// 長度上限
assert.strictEqual(sanitizeMessage('x'.repeat(600)).length, 501, '超長須截斷並加省略號');

// ── permanent：資料不合法，重試永遠失敗 ──
for (const code of ['RAGIC_VALIDATION_ERROR', 'RAGIC_APPLICATION_ERROR',
  'RAGIC_UID_FIELD_SCHEMA_MISMATCH', 'RAGIC_UID_DUPLICATE', 'RAGIC_HTTP_CLIENT_ERROR']) {
  assert.strictEqual(classifyRagicError({ code, message: 'x' }).kind, 'permanent', `${code} 應為 permanent`);
}
assert.strictEqual(classifyRagicError({ code: '23505', message: 'dup' }).kind, 'permanent', 'PG 唯一鍵衝突應為 permanent');

// ── transient：重試有機會成功 ──
for (const code of ['RAGIC_TIMEOUT', 'RAGIC_NETWORK_ERROR', 'RAGIC_HTTP_SERVER_ERROR',
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']) {
  assert.strictEqual(classifyRagicError({ code, message: 'x' }).kind, 'transient', `${code} 應為 transient`);
}

// ── 重試耗盡：要看 cause 的真正死因 ──
{
  const err = { code: 'RAGIC_RETRY_EXHAUSTED', message: 'Ragic 重試 3 次後仍失敗',
    cause: { code: 'RAGIC_VALIDATION_ERROR', message: '欄位為必填' } };
  const c = classifyRagicError(err);
  assert.strictEqual(c.kind, 'permanent', 'cause 是資料問題 → 不該被歸為 transient');
  assert.strictEqual(c.code, 'RAGIC_RETRY_EXHAUSTED', 'code 保留外層，便於對照 log');
}
{
  const err = { code: 'RAGIC_RETRY_EXHAUSTED', message: 'x', cause: { code: 'RAGIC_TIMEOUT', message: 'slow' } };
  assert.strictEqual(classifyRagicError(err).kind, 'transient');
}
{
  // cause 無法分類時，退回 transient（重試耗盡本身就是暫時性語意）
  const err = { code: 'RAGIC_RETRY_EXHAUSTED', message: 'x', cause: { code: 'WEIRD', message: 'y' } };
  assert.strictEqual(classifyRagicError(err).kind, 'transient');
}

// ── 沒有 code 時退回訊息特徵 ──
assert.strictEqual(classifyRagicError({ message: 'Ragic INVALID 202: 欄位 (報)Email 為必填' }).kind, 'permanent',
  '真實案例：這正是 backup 每天失敗的那則訊息');
assert.strictEqual(classifyRagicError({ message: 'Field id PAGEID not found' }).kind, 'permanent');
assert.strictEqual(classifyRagicError({ message: '不明狀況' }).kind, 'unknown');

// ── 防呆 ──
assert.strictEqual(classifyRagicError(null).kind, 'unknown');
assert.strictEqual(classifyRagicError(undefined).kind, 'unknown');
assert.strictEqual(classifyRagicError(new Error('boom')).kind, 'unknown');
assert.strictEqual(classifyRagicError({ code: 'X' }).code, 'X');

// ── 分類結果的 message 必須是去識別化後的版本 ──
{
  const c = classifyRagicError({ code: 'RAGIC_VALIDATION_ERROR', message: '家長 poyu@gmail.com 缺欄位' });
  assert.ok(!c.message.includes('poyu@gmail.com'), 'message 不得含原始 email');
  assert.ok(c.message.includes('<email>'));
}

console.log('sync_failure_log_test: PASS');

// ── Phase 2 隔離（2026-08）────────────────────────────────
{
  const { classifyRagicError, stuckExclusionSql } = require('../server/services/syncFailureLog');

  // 身分證撞號重試一萬次也不會變成沒撞號。原本沒列進 PERMANENT_CODES，
  // 被歸成 unknown 而永遠重試（正式庫累積 186 次 / 25 筆）。
  const dup = classifyRagicError(Object.assign(new Error('身分證字號已被其他學員使用'),
    { code: 'STUDENT_ID_NUMBER_EXISTS' }));
  assert.strictEqual(dup.kind, 'permanent', '身分證撞號必須歸為永久性失敗');

  const sql = stuckExclusionSql('p', 'Z01_Z02_BACKUP', 'parent');
  // 綁 updated_at 是自癒的關鍵：資料修好就自動脫離隔離。
  // 少了這個條件，隔離會變成另一種災難 —— 修好了卻永遠不再同步。
  assert.ok(sql.includes('f.occurred_at >= p.updated_at'),
    '隔離判準必須綁在該筆的 updated_at 上，否則修好了也不會恢復');
  // local_id 是 uuid，寫成 ::text 會在執行期炸 operator does not exist: uuid = text。
  assert.ok(/f\.local_id = p\.id(?!::)/.test(sql),
    'local_id 是 uuid，不可以轉成 text 比對');
  assert.ok(sql.trim().startsWith('NOT EXISTS'), '要能直接接在 WHERE 後面');
  console.log('  ok   Phase 2 隔離：分類、自癒判準、uuid 型別');
}
