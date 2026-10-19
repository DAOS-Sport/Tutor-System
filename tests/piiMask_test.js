const assert = require('assert');
const { maskName, maskStudentName, maskIdNumber, maskPhone } = require('../server/utils/piiMask');

function testMaskPhone() {
  assert.strictEqual(maskPhone('0900796878'), '0900****78');
  assert.strictEqual(maskPhone(''), '');
  assert.strictEqual(maskPhone(null), '');
  assert.strictEqual(maskPhone(undefined), '');
  assert.strictEqual(maskPhone('1234'), '****');
  assert.strictEqual(maskPhone('123456'), '******');
  assert.strictEqual(maskPhone('1234567'), '1234*67');
  // never leaks the original substring anywhere in the middle for a typical phone
  const masked = maskPhone('0900796878');
  assert.ok(!masked.includes('0796'));
}

function testMaskName() {
  assert.strictEqual(maskName('王明'), '王X');
  assert.strictEqual(maskName('莊柏彥'), '莊X彥');
  assert.strictEqual(maskName('歐陽宇哲'), '歐XX哲');
  assert.strictEqual(maskName(''), '');
  assert.strictEqual(maskName(null), '');
}

function testMaskStudentNameAndId() {
  assert.strictEqual(maskStudentName('張小明'), '張同學');
  assert.strictEqual(maskStudentName(''), '');
  assert.strictEqual(maskIdNumber('A132702114'), '**********');
  assert.strictEqual(maskIdNumber(''), '');
}

testMaskPhone();
testMaskName();
testMaskStudentNameAndId();
console.log('piiMask_test: PASS');
