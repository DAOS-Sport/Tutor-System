'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  evaluateParentIdentityCanary,
  __test__,
} = require('../../server/services/parentIdentityCanary');

const original = {
  flag: process.env.PARENT_IDENTITY_RESOLVER_V2,
  phase: process.env.PARENT_IDENTITY_CANARY_PHASE,
  percent: process.env.PARENT_IDENTITY_CANARY_PERCENT,
  uidHashes: process.env.PARENT_IDENTITY_CANARY_LINE_UID_HASHES,
  phones: process.env.PARENT_IDENTITY_CANARY_PHONES,
  sources: process.env.PARENT_IDENTITY_CANARY_SOURCE_RECORD_IDS,
};

try {
  process.env.PARENT_IDENTITY_RESOLVER_V2 = 'true';
  process.env.PARENT_IDENTITY_CANARY_PHASE = 'allowlist';
  process.env.PARENT_IDENTITY_CANARY_LINE_UID_HASHES = __test__.sha256('Uinternal');
  process.env.PARENT_IDENTITY_CANARY_PHONES = '0912345678';
  assert.strictEqual(evaluateParentIdentityCanary({ lineUid: 'Uinternal' }).allowed, true);
  assert.strictEqual(evaluateParentIdentityCanary({ phone: '0912-345-678' }).allowed, true);
  assert.strictEqual(evaluateParentIdentityCanary({ sourceRecordIds: ['149'] }).allowed, true);
  assert.strictEqual(evaluateParentIdentityCanary({ sourceRecordIds: ['6504'] }).allowed, true);
  assert.strictEqual(evaluateParentIdentityCanary({ sourceRecordIds: ['6786'] }).allowed, true);
  assert.strictEqual(evaluateParentIdentityCanary({ lineUid: 'Unot-allowed', sourceRecordIds: ['99999'] }).allowed, false);
  assert.strictEqual(evaluateParentIdentityCanary({
    lineUid: 'Uinternal', existingLocalLineUidFound: true,
  }).reason, 'EXISTING_USER_FAST_PATH_EXCLUDED');

  process.env.PARENT_IDENTITY_CANARY_PHASE = 'percentage';
  for (const percent of [5, 20, 50, 100]) {
    process.env.PARENT_IDENTITY_CANARY_PERCENT = String(percent);
    const verdict = evaluateParentIdentityCanary({ lineUid: 'Upercentage-user' });
    assert.strictEqual(verdict.allowed, verdict.bucket < percent);
  }
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'parent-identity-canary.json'), 'utf8'));
  assert.deepStrictEqual(config.phase_3.sequence_percent, [5, 20, 50, 100]);
  assert.strictEqual(config.existing_user_fast_path.percentage_experiment, false);
  console.log('canary_config_test: PASS (allowlist, known records, deterministic percentage, existing-fastpath exclusion)');
} finally {
  const restore = (name, value) => { if (value == null) delete process.env[name]; else process.env[name] = value; };
  restore('PARENT_IDENTITY_RESOLVER_V2', original.flag);
  restore('PARENT_IDENTITY_CANARY_PHASE', original.phase);
  restore('PARENT_IDENTITY_CANARY_PERCENT', original.percent);
  restore('PARENT_IDENTITY_CANARY_LINE_UID_HASHES', original.uidHashes);
  restore('PARENT_IDENTITY_CANARY_PHONES', original.phones);
  restore('PARENT_IDENTITY_CANARY_SOURCE_RECORD_IDS', original.sources);
}
