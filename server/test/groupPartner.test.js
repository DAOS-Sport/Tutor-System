const test = require('node:test');
const assert = require('node:assert/strict');
const { partnerCheckinLabel, partnerParentTitle } = require('../services/groupPartner');

test('group partner label uses surname and physiological gender title', () => {
  assert.equal(partnerCheckinLabel('王小華', '生理女'), '團報夥伴王媽媽');
  assert.equal(partnerCheckinLabel('李大明', '生理男'), '團報夥伴李爸爸');
  assert.equal(partnerCheckinLabel('陳家長', '女'), '團報夥伴陳媽媽');
});

test('unknown or private gender falls back to neutral parent title', () => {
  assert.equal(partnerParentTitle('不方便透漏'), '家長');
  assert.equal(partnerCheckinLabel('林同學家長', ''), '團報夥伴林家長');
  assert.equal(partnerCheckinLabel('', null), '團報夥伴家長');
});
