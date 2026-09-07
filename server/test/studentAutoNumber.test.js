'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FIELD } = require('../services/ragic');
const source = fs.readFileSync(path.join(__dirname, '../services/ragic.js'), 'utf8');

for (const name of ['_buildZ02RegistrationPayload', 'buildZ02StudentPayload']) {
  test(name + ' leaves new student numbers to Ragic and preserves known numbers', async () => {
    const start = source.indexOf('async function ' + name + '(');
    assert.ok(start >= 0);
    const build = vm.runInNewContext('(' + source.slice(start, source.indexOf('\n}', start) + 2) + ')', {
      FIELD, formatRagicDate: x => x, _toPhysGender: x => x, venueLabel: async () => 'Test venue',
    });
    for (const student_code of [null, undefined, '', '   ']) {
      const payload = await build({ parent: {}, student: { student_code, id_number: 'A123456789' } });
      assert.equal(Object.hasOwn(payload, FIELD.Z02.STUDENT_CODE), false,
        'do not send an empty code or substitute the national ID');
      assert.equal(payload[FIELD.Z02.ID_NUMBER], 'A123456789');
    }
    const payload = await build({ parent: {}, student: { student_code: 'S00042' } });
    assert.equal(payload[FIELD.Z02.STUDENT_CODE], 'S00042');
  });
}
