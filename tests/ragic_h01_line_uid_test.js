const assert = require('assert');
const ragicAdmin = require('../server/services/ragicAdmin');

const { extractLineUid, normalizeLineUserId } = ragicAdmin.__test__;

function testField1003633IsPreferred() {
  const uid = 'U5713b8dca03d3a78777891da2e9f12b6';
  const row = {
    '400Line訊息': 'U00000000000000000000000000000000',
    'LINE userid': 'U11111111111111111111111111111111',
    line_uid: 'U22222222222222222222222222222222',
    個人LINEID: 'U33333333333333333333333333333333',
    '個人LINE ID': 'U44444444444444444444444444444444',
    '1003633': uid,
  };
  assert.strictEqual(extractLineUid(row), uid);
}

function testExactDisplayNameFallback() {
  const uid = 'U9e92f89d85709c449664973fbba2af32';
  const row = {
    '400Line訊息': 'U00000000000000000000000000000000',
    'LINE userid': 'U11111111111111111111111111111111',
    line_uid: 'U22222222222222222222222222222222',
    個人LINEID: 'U33333333333333333333333333333333',
    '個人LINE ID': uid,
  };
  assert.strictEqual(extractLineUid(row), uid);
}

function testNoFallbackToMessageField() {
  const row = {
    '400Line訊息': 'U00000000000000000000000000000000',
    'LINE userid': 'U11111111111111111111111111111111',
    line_uid: 'U22222222222222222222222222222222',
    個人LINEID: 'U33333333333333333333333333333333',
  };
  assert.strictEqual(extractLineUid(row), '');
}

function testRejectsNonLineUserId() {
  assert.strictEqual(normalizeLineUserId('l400-message-id'), '');
  assert.strictEqual(normalizeLineUserId('U5713b8dca03d3a78777891da2e9f12b'), '');
  assert.strictEqual(normalizeLineUserId(' U5713b8dca03d3a78777891da2e9f12b6 '), 'U5713b8dca03d3a78777891da2e9f12b6');
  assert.strictEqual(normalizeLineUserId('U5713B8DCA03D3A78777891DA2E9F12B6'), 'U5713B8DCA03D3A78777891DA2E9F12B6');
}

testField1003633IsPreferred();
testExactDisplayNameFallback();
testNoFallbackToMessageField();
testRejectsNonLineUserId();
console.log('ragic_h01_line_uid_test: PASS');
