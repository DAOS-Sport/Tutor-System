const assert = require('assert');
const ragicAdmin = require('../server/services/ragicAdmin');

const { h23CourseCoefficient } = ragicAdmin.__test__;

function testFieldIdWins() {
  const row = {
    '1006300': '1.15',
    '家教班倍率(目前)': '1.2',
  };
  assert.strictEqual(h23CourseCoefficient(row), 1.15);
}

function testCurrentDisplayNameFallback() {
  const row = {
    '家教班倍率(目前)': '1.2',
  };
  assert.strictEqual(h23CourseCoefficient(row), 1.2);
}

function testInvalidValueFallsBackToOne() {
  assert.strictEqual(h23CourseCoefficient({ '家教班倍率(目前)': 'abc' }), 1.00);
  assert.strictEqual(h23CourseCoefficient({}), 1.00);
}

testFieldIdWins();
testCurrentDisplayNameFallback();
testInvalidValueFallsBackToOne();
console.log('ragic_h23_coefficient_test: PASS');
