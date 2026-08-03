'use strict';
// Ragic 基線稽核 — 遮罩與分類的單元測試（零外部相依：不連 DB、不連 Ragic）
const assert = require('assert');
const {
  maskEmail, maskPhone, maskLineUid, maskIdNumber, maskUuid,
  classifyPendingRow, classifyRemoteReconcile, markSuperseded,
} = require('../scripts/ragicBaselineAudit');

// ── 遮罩：Email ──
assert.strictEqual(maskEmail('poyu@gmail.com'), 'po**@gmail.com');
assert.strictEqual(maskEmail('a@b.co'), 'a*@b.co', '單字元 local part 仍須至少一個星號');
assert.strictEqual(maskEmail('  ian@x.com '), 'ia*@x.com', '前後空白須先 trim');
assert.strictEqual(maskEmail('noatsign'), 'no***', '非法格式也不得原樣輸出');
assert.strictEqual(maskEmail(''), '');
assert.strictEqual(maskEmail(null), '');
assert.strictEqual(maskEmail(undefined), '');
assert.ok(!maskEmail('secret@x.com').includes('secret'), '不得洩漏完整 local part');

// ── 遮罩：電話 ──
assert.strictEqual(maskPhone('0956736161'), '09****6161');
assert.strictEqual(maskPhone('09-5673-6161'), '09****6161', '非數字須先移除');
assert.strictEqual(maskPhone('12345'), '12***');
assert.strictEqual(maskPhone(''), '');
assert.strictEqual(maskPhone(null), '');
assert.ok(!maskPhone('0956736161').includes('5673'), '中段不得外露');

// ── 遮罩：LINE UID ──
assert.strictEqual(maskLineUid('Ufd5b5ffdc9e72df19862f1b3f823747a'), 'Ufd5b…747a');
assert.strictEqual(maskLineUid('U12345'), 'U1…45');
assert.strictEqual(maskLineUid(''), '');
assert.ok(!maskLineUid('Ufd5b5ffdc9e72df19862f1b3f823747a').includes('c9e72df'), '中段不得外露');

// ── 遮罩：身分證 ──
assert.strictEqual(maskIdNumber('A123456789'), 'A1*****789');
assert.strictEqual(maskIdNumber('AB12'), 'A***');
assert.strictEqual(maskIdNumber(''), '');
assert.ok(!maskIdNumber('A123456789').includes('23456'), '中段不得外露');

// ── 遮罩：UUID ──
assert.strictEqual(maskUuid('c8b27d21-db4a-4dc8-a069-4a267620a87a'), 'c8b27d21…a87a');
assert.strictEqual(maskUuid('short'), 'short');
assert.strictEqual(maskUuid(''), '');

// ── 分類：家長缺欄位的六種情形 ──
const okParent = { name: '王大明', gender: '生理男', primary_venue_id: 'B', email: 'a@b.com' };
assert.strictEqual(classifyPendingRow(okParent, 'parent').blocked, false, '完整資料不得判為 blocked');

const cases = [
  [{ ...okParent, email: null }, 'email_null'],
  [{ ...okParent, email: undefined }, 'email_null'],
  [{ ...okParent, email: '' }, 'email_empty_string'],
  [{ ...okParent, email: '   ' }, 'email_whitespace_only'],
  [{ ...okParent, email: 'not-an-email' }, 'email_format_invalid'],
  [{ ...okParent, name: '' }, 'missing_name'],
  [{ ...okParent, gender: '' }, 'missing_gender'],
  [{ ...okParent, primary_venue_id: null }, 'missing_venue'],
];
for (const [row, expected] of cases) {
  const c = classifyPendingRow(row, 'parent');
  assert.ok(c.blocked, `${expected} 應判為 blocked`);
  assert.ok(c.reasons.includes(expected), `應含原因 ${expected}，實際 ${c.reasons.join(',')}`);
}
// 格式錯誤歸 invalidFields、缺漏歸 missingFields，兩者不可混淆
assert.deepStrictEqual(classifyPendingRow({ ...okParent, email: 'bad' }, 'parent').invalidFields, ['email']);
assert.deepStrictEqual(classifyPendingRow({ ...okParent, email: null }, 'parent').missingFields, ['email']);

// ── 分類：學員 ──
const okStudent = { name: '王小明', id_number: 'A123456789', email: 'a@b.com' };
assert.strictEqual(classifyPendingRow(okStudent, 'student').blocked, false);
assert.ok(classifyPendingRow({ ...okStudent, id_number: '' }, 'student').reasons.includes('missing_id_number'));

// ── 分類：遠端核對 0／1／多筆與衝突 ──
assert.strictEqual(classifyRemoteReconcile({ remote: [], localRagicRecordId: null }), 'remote_not_found');
assert.strictEqual(classifyRemoteReconcile({ remote: [{ _ragicId: '1005' }], localRagicRecordId: '1005' }), 'remote_found_single');
assert.strictEqual(classifyRemoteReconcile({ remote: [{ _ragicId: '1005' }, { _ragicId: '1006' }], localRagicRecordId: '1005' }), 'remote_found_multiple');
assert.strictEqual(classifyRemoteReconcile({ remote: [{ _ragicId: '9999' }], localRagicRecordId: '1005' }), 'local_remote_conflict');
assert.strictEqual(classifyRemoteReconcile({ remote: [{ _ragicId: '1005' }], localRagicRecordId: null }), 'possible_already_applied',
  '遠端有、本地無編號 → 疑似已套用（重跑會重複建立的風險點）');
assert.strictEqual(classifyRemoteReconcile({ timedOut: true }), 'remote_lookup_timeout');
assert.strictEqual(classifyRemoteReconcile({ error: new Error('x') }), 'remote_lookup_error');

// ── 分類：同一 parent 多筆 → 最新以外標 superseded ──
{
  const items = [
    { id: 'a', canonical_parent_id: 'P1', created_at: '2026-07-01T00:00:00Z' },
    { id: 'b', canonical_parent_id: 'P1', created_at: '2026-08-01T00:00:00Z' },
    { id: 'c', canonical_parent_id: 'P2', created_at: '2026-07-15T00:00:00Z' },
  ];
  const s = markSuperseded(items);
  assert.ok(s.has('a'), '舊事件應標 superseded');
  assert.ok(!s.has('b'), '最新事件不得標 superseded');
  assert.ok(!s.has('c'), '單筆不得標 superseded');
  assert.strictEqual(markSuperseded([]).size, 0);
  assert.strictEqual(markSuperseded(null).size, 0);
}

// ── require 本 script 不得產生副作用（不連 DB、不啟動任何東西）──
assert.strictEqual(typeof maskEmail, 'function', 'require 應只取得純函式');

console.log('ragic_baseline_audit_test: PASS');