'use strict';
/**
 * 舊家教系統移轉的上課紀錄已在舊系統結算（Owner 2026-10-20）：只有在新系統簽到的才算教練薪資。
 *
 * 守的契約（numberLessons，上課紀錄報表與薪資匯出共用）：
 *   1. 只有舊系統簽到的一堂：不計教練堂數、簽到時間清空（匯出與總堂數表只收有簽到時間的列）。
 *   2. 舊系統的課照樣佔堂號與購買上限：新系統的第一次簽到接著編第 N+1 堂。
 *   3. 購買上限仍算入舊系統已用的堂數：超過的新簽到照樣不計。
 *   4. 同一堂若有新系統的有效簽到，就照常計薪。
 *   5. 沒有購買身分（不進編號）的舊系統簽到也不計。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { numberLessons } = require('../server/services/lessonSequence');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const identity = { purchase_id: 'ABL20412', period_id: 'P1', shared_purchase: false, total_sessions: 4, period_number: 1 };
const legacy = (id, at) => ({
  id, report_identity: identity, transaction_period: 'ABL20412-1', payroll_lesson_count: 1, checkin_at: at,
  checkin_details: [{ source: 'legacy_import', status: 'ATTENDED', at }],
});
const fresh = (id, at, extra = []) => ({
  id, report_identity: identity, transaction_period: 'ABL20412-1', payroll_lesson_count: 1, checkin_at: at,
  checkin_details: [{ source: 'parent', status: 'ATTENDED', at }, ...extra],
});

const rows = numberLessons([
  legacy('L1', '2026-09-03T02:00:00Z'),
  legacy('L2', '2026-09-10T02:00:00Z'),
  fresh('N1', '2026-10-24T02:00:00Z'),
  fresh('N2', '2026-10-31T02:00:00Z'),
  fresh('N3', '2026-11-07T02:00:00Z'),
]);
const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

check('只有舊系統簽到的一堂不計教練堂數、簽到時間清空、原時間保留', () => {
  for (const id of ['L1', 'L2']) {
    assert.strictEqual(byId[id].payroll_lesson_count, 0, id);
    assert.strictEqual(byId[id].checkin_at, null, id);
    assert.strictEqual(byId[id].legacy_settled, true, id);
    assert.ok(byId[id].legacy_checkin_at, id);
  }
});

check('舊系統的課佔堂號：新系統第一次簽到是第 3 堂', () => {
  assert.strictEqual(byId.L1.lesson_seq, 1);
  assert.strictEqual(byId.L2.lesson_seq, 2);
  assert.strictEqual(byId.N1.lesson_seq, 3);
  assert.strictEqual(byId.N1.payroll_lesson_count, 1);
  assert.strictEqual(byId.N1.checkin_at, '2026-10-24T02:00:00Z');
  assert.strictEqual(byId.N1.lesson_no, 'ABL20412-1-3');
});

check('購買上限算入舊系統已用：4 堂的包，第 5 次簽到不計', () => {
  assert.strictEqual(byId.N2.payroll_lesson_count, 1);
  assert.strictEqual(byId.N3.lesson_over_cap, true);
  assert.strictEqual(byId.N3.payroll_lesson_count, 0);
});

check('同一堂有新系統的有效簽到就照常計薪；已註銷的新簽到不算', () => {
  const [mixed, reversed] = numberLessons([
    { ...legacy('M1', '2026-09-03T02:00:00Z'), checkin_details: [
      { source: 'legacy_import', status: 'ATTENDED' }, { source: 'staff', status: 'ATTENDED' }] },
    { ...legacy('M2', '2026-09-10T02:00:00Z'), checkin_details: [
      { source: 'legacy_import', status: 'ATTENDED' }, { source: 'staff', status: 'REVERSED' }] },
  ]);
  assert.strictEqual(mixed.payroll_lesson_count, 1);
  assert.notStrictEqual(mixed.checkin_at, null);
  assert.strictEqual(reversed.payroll_lesson_count, 0);
});

check('舊系統本來就超用的：只標已結算，不標成新的超額簽到', () => {
  const small = { ...identity, total_sessions: 1 };
  const out = numberLessons([
    { ...legacy('O1', '2026-09-03T02:00:00Z'), report_identity: small },
    { ...legacy('O2', '2026-09-10T02:00:00Z'), report_identity: small },
  ]);
  for (const row of out) {
    assert.strictEqual(row.legacy_settled, true);
    assert.notStrictEqual(row.lesson_over_cap, true);
    assert.strictEqual((row.lesson_cap_notes || []).length, 0);
  }
});

check('沒有購買身分的舊系統簽到也不計', () => {
  const [row] = numberLessons([{ ...legacy('U1', '2026-09-03T02:00:00Z'), report_identity: null }]);
  assert.strictEqual(row.payroll_lesson_count, 0);
  assert.strictEqual(row.checkin_at, null);
});

check('評鑑邀請不因舊系統簽到觸發（切換不推播）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server/cron/index.js'), 'utf8');
  const block = src.slice(src.indexOf("scheduleTaipei('5 * * * *'"), src.indexOf('(b) 邀請超過 7 天未填'));
  assert.ok(/cr\.checked_in_source\s*<>\s*'legacy_import'/.test(block), '評鑑邀請觸發條件沒有排除舊系統簽到');
});

if (failed) {
  console.error('\nlegacy_settled_payroll_test: ' + failed + ' failed');
  process.exit(1);
}
console.log('legacy_settled_payroll_test: all passed');
