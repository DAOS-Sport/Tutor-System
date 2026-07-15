const test = require('node:test');
const assert = require('node:assert/strict');
const { flagAllowsPhone, normalizePhone } = require('../services/featureFlags');

test('canary feature flags only allow configured phone', () => {
  const flag = { enabled: true, allowedPhones: ['0982252694'] };
  assert.equal(flagAllowsPhone(flag, '0982-252-694'), true);
  assert.equal(flagAllowsPhone(flag, '0912345678'), false);
  assert.equal(normalizePhone(' 0982 252 694 '), '0982252694');
});

test('empty allowlist means globally enabled and disabled wins', () => {
  assert.equal(flagAllowsPhone({ enabled: true, allowedPhones: [] }, '0912345678'), true);
  assert.equal(flagAllowsPhone({ enabled: false, allowedPhones: [] }, '0982252694'), false);
});
