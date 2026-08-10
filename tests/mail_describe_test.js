'use strict';
/**
 * 寄信設定摘要的外露鎖。
 *
 * describe() 是給公開的 /health 用的，所以它「不回什麼」比「回什麼」更重要：
 * 任何一次不小心把主機、帳號或密碼放進去，就是把 SMTP 憑證掛在公開端點上。
 */
const assert = require('assert');
const path = require('path');
const mailer = require(path.join(__dirname, '..', 'server/services/mailer'));

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'MAIL_DRY_RUN', 'MAIL_TEST_RECIPIENT'];
function withEnv(vars, fn) {
  const old = {};
  KEYS.forEach((k) => { old[k] = process.env[k]; delete process.env[k]; });
  Object.keys(vars).forEach((k) => { process.env[k] = vars[k]; });
  try { return fn(); } finally {
    KEYS.forEach((k) => { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; });
  }
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

console.log('mail_describe_test');

const SECRETS = {
  SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587',
  SMTP_USER: 'someone@example.com', SMTP_PASS: 'super-secret-pw',
  SMTP_FROM: 'someone@example.com', MAIL_TEST_RECIPIENT: 'tester@example.com',
};

check('describe() 只回布林，不得夾帶任何設定值', () => {
  withEnv(SECRETS, () => {
    const d = mailer.describe();
    const json = JSON.stringify(d);
    assert.ok(Object.keys(d).length >= 3, '欄位太少 —— 掃描失效，非真的通過');
    Object.entries(d).forEach(([k, v]) => {
      assert.strictEqual(typeof v, 'boolean', '欄位 ' + k + ' 不是布林（型別 ' + typeof v + '）');
    });
    // 逐一比對每個設定值，不是只擋密碼 —— 主機名與帳號同樣不該外露。
    Object.entries(SECRETS).forEach(([k, v]) => {
      assert.ok(!json.includes(v), 'describe() 洩漏了 ' + k + ' 的值');
    });
  });
});

check('未設定時 configured=false（這正是要被看見的狀態）', () => {
  withEnv({}, () => {
    const d = mailer.describe();
    assert.strictEqual(d.configured, false);
    assert.strictEqual(d.testRecipientSet, false);
  });
});

check('設定完整時 configured=true', () => {
  withEnv(SECRETS, () => {
    const d = mailer.describe();
    assert.strictEqual(d.configured, true);
    assert.strictEqual(d.testRecipientSet, true, 'MAIL_TEST_RECIPIENT 有設就該回 true');
  });
});

check('MAIL_DRY_RUN 會被如實回報（設定完整但不寄，最容易被誤判成正常）', () => {
  withEnv({ ...SECRETS, MAIL_DRY_RUN: '1' }, () => {
    const d = mailer.describe();
    assert.strictEqual(d.configured, true);
    assert.strictEqual(d.dryRun, true, 'dryRun 沒回報 —— 會看起來一切正常但信永遠不寄');
  });
});

if (failures) { console.error('\nmail_describe_test: ' + failures + ' failed'); process.exit(1); }
console.log('mail_describe_test: all passed');
process.exit(0);
