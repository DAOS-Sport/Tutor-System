'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { matchFamilyStudent } = require('../services/familyStudentMatch');

const child = { id: 'child', name: '同名學員', id_number: 'A123456789', ragic_record_id: '42' };
const identified = { name: child.name, id_number: child.id_number, birth_date: '2012-01-01', gender: '男' };
const normalizeGender = (v) => v === '生理男' ? '男' : v;

test('Z01 subtable IDs cannot select a different sibling with the same Z02 ID', () => {
  const sibling = { ...child, id: 'sibling', name: '另一位學員', id_number: 'B123456789' };
  const incoming = { ...identified, ragic_record_id: '42', ragic_id_namespace: 'Z01_SUBTABLE' };
  assert.equal(matchFamilyStudent([{ ...child, ragic_record_id: '99' }, sibling], incoming).row.id, child.id);
});

test('unqualified Ragic IDs do not override identity; qualified Z02 IDs still allow renames', () => {
  const incoming = { name: '更正姓名', id_number: child.id_number, ragic_record_id: '42' };
  assert.equal(matchFamilyStudent([child], incoming).row, undefined);
  assert.equal(matchFamilyStudent([child], { ...incoming, ragic_id_namespace: 'Z02' }).row, child);
});

for (const [label, patch] of [
  ['birthday', { birth_date: '2015-06-06' }],
  ['gender', { gender: '女' }],
]) {
  for (const ragicId of [null, '42']) {
    test(`taken student rejects conflicting no-ID ${label}, with Ragic ID ${ragicId}`, () => {
      const incoming = { name: child.name, ...patch, ragic_record_id: ragicId, ragic_id_namespace: 'Z02' };
      const result = matchFamilyStudent([child], incoming, { taken: new Map([[child.id, identified]]), normalizeGender });
      assert.ok(result.ambiguous);
      assert.equal(result.row, undefined);
    });
  }
}

test('compatible no-ID rows are duplicates, including normalized genders', () => {
  for (const ragicId of [null, '42']) {
    const incoming = { name: child.name, birth_date: identified.birth_date, gender: '生理男',
      ragic_record_id: ragicId, ragic_id_namespace: 'Z02' };
    assert.deepEqual(matchFamilyStudent([child], incoming, {
      taken: new Map([[child.id, identified]]), normalizeGender,
    }), { row: child, duplicate: true });
  }
});

test('a single untaken same-name student still matches an input without ID', () => {
  assert.deepEqual(matchFamilyStudent([child], { name: child.name }), { row: child });
});
