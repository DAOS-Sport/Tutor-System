const test = require('node:test');
const assert = require('node:assert/strict');
const { flagAllowsPhone, normalizePhone } = require('../services/featureFlags');

test('canary feature flags only allow configured phone', () => {
  const flag = { enabled: true, allowedPhones: ['0900652594'] };
  assert.equal(flagAllowsPhone(flag, '0900-652-594'), true);
  assert.equal(flagAllowsPhone(flag, '0900796878'), false);
  assert.equal(normalizePhone(' 0900 652 594 '), '0900652594');
});

test('empty allowlist means globally enabled and disabled wins', () => {
  assert.equal(flagAllowsPhone({ enabled: true, allowedPhones: [] }, '0900796878'), true);
  assert.equal(flagAllowsPhone({ enabled: false, allowedPhones: [] }, '0900652594'), false);
});
