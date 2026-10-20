'use strict';
// 家長認領的學員核對規則（Owner 2026-10-20，claimStudentMatcher）。
const assert = require('assert');
const { matchStudent } = require('../server/services/claimStudentMatcher');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const family = [
  { name: '林語彤', id_number: 'Q200000001' },
  { name: '林語彤', id_number: 'Q200000001' },
  { name: '林小樂', id_number: '' },
];

check('姓名完全相同（全形空白、大小寫不計）→ EXACT，同名重複都帶回', () => {
  const v = matchStudent(family, { name: '林 語彤' });
  assert.strictEqual(v.method, 'EXACT');
  assert.strictEqual(v.candidates.length, 2);
});

check('姓名只差一字 → NEAR，回登記姓名', () => {
  const v = matchStudent(family, { name: '林語桐' });
  assert.strictEqual(v.method, 'NEAR');
  assert.strictEqual(v.candidates[0].name, '林語彤');
});

check('身分證相同、姓名完全不同 → ID', () => {
  const v = matchStudent(family, { name: '某某某', id_number: 'q200000001' });
  assert.strictEqual(v.method, 'ID');
  assert.strictEqual(v.candidates[0].name, '林語彤');
});

check('姓名對上但送來的身分證和登記的不同 → 衝突', () => {
  assert.deepStrictEqual(matchStudent(family, { name: '林語彤', id_number: 'B123456789' }), { conflict: true });
});

check('只差一字但登記的身分證不同 → 是另一個孩子，不算對上（也不算衝突）', () => {
  assert.strictEqual(matchStudent(family, { name: '林語桐', id_number: 'B123456789' }), null);
});

check('兩個字的姓名、或姓氏不同 → 不算 NEAR', () => {
  assert.strictEqual(matchStudent([{ name: '王明' }], { name: '王亮' }), null);
  assert.strictEqual(matchStudent(family, { name: '陽詩涵' }), null);
});

check('allowNear: false（會新增學員的路徑）→ 只差一字的兄弟姊妹不對到既有學員', () => {
  const kids = [{ name: '陳冠宇', id_number: '' }];
  assert.strictEqual(matchStudent(kids, { name: '陳冠廷' }).method, 'NEAR');
  assert.strictEqual(matchStudent(kids, { name: '陳冠廷' }, { allowNear: false }), null);
  assert.strictEqual(matchStudent(kids, { name: '陳冠宇' }, { allowNear: false }).method, 'EXACT');
});

check('同名優先：送來的身分證是兄弟姊妹的，仍對到同名的這位', () => {
  const kids = [{ name: '李小華', id_number: '' }, { name: '李小美', id_number: 'B223456789' }];
  const v = matchStudent(kids, { name: '李小華', id_number: 'B223456789' });
  assert.strictEqual(v.method, 'EXACT');
  assert.strictEqual(v.candidates[0].name, '李小華');
});

check('登記沒有身分證時，送來的身分證不構成衝突', () => {
  assert.strictEqual(matchStudent(family, { name: '林小樂', id_number: 'C123456789' }).method, 'EXACT');
});

check('差兩個字、長度不同、只有一個字的姓名 → 不算', () => {
  assert.strictEqual(matchStudent(family, { name: '林雨桐' }), null);
  assert.strictEqual(matchStudent(family, { name: '林語彤涵' }), null);
  assert.strictEqual(matchStudent([{ name: '安' }], { name: '平' }), null);
});

check('只差一字卻對到兩位不同的孩子 → 不猜', () => {
  assert.strictEqual(matchStudent([{ name: '王小明' }, { name: '王小名' }], { name: '王小銘' }), null);
});

if (failed) {
  console.error('\nclaim_student_matcher_test: ' + failed + ' failed');
  process.exit(1);
}
console.log('claim_student_matcher_test: all passed');
