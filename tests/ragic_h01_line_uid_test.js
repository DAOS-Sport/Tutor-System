const assert = require('assert');
const ragicAdmin = require('../server/services/ragicAdmin');

const { extractLineUid, normalizeLineUserId } = ragicAdmin.__test__;

function testOnlyField1003633IsAccepted() {
  const uid = 'U5713b8dca03d3a78777891da2e9f12b6';
  const row = {
    '400Line訊息': 'U00000000000000000000000000000000',
    'LINE userid': 'U11111111111111111111111111111111',
    line_uid: 'U22222222222222222222222222222222',
    個人LINEID: 'U33333333333333333333333333333333',
    '1003633': uid,
  };
  assert.strictEqual(extractLineUid(row), uid);
}

function testNoFallbackToMessageField() {
  const row = {
    '400Line訊息': 'U00000000000000000000000000000000',
    'LINE userid': 'U11111111111111111111111111111111',
    line_uid: 'U22222222222222222222222222222222',
  };
  assert.strictEqual(extractLineUid(row), '');
}

function testRejectsNonLineUserId() {
  assert.strictEqual(normalizeLineUserId('l400-message-id'), '');
  assert.strictEqual(normalizeLineUserId('U5713b8dca03d3a78777891da2e9f12b'), '');
  assert.strictEqual(normalizeLineUserId(' U5713b8dca03d3a78777891da2e9f12b6 '), 'U5713b8dca03d3a78777891da2e9f12b6');
  assert.strictEqual(normalizeLineUserId('U5713B8DCA03D3A78777891DA2E9F12B6'), 'U5713B8DCA03D3A78777891DA2E9F12B6');
}

testOnlyField1003633IsAccepted();
testNoFallbackToMessageField();
testRejectsNonLineUserId();
console.log('ragic_h01_line_uid_test: PASS');
