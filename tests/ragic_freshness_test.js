const assert = require('assert');
const {
  filterCanaryRecords,
  runCanaryWriteReadProof,
} = require('../server/services/ragicFreshness');

const config = {
  sheetCode: 'H01',
  recordId: '999',
  nonceField: '3009999',
  nonceFieldName: 'canary_nonce',
  identifierField: '3000935',
  identifierFieldName: '員工編號',
  identifierValue: 'ZZ-CANARY',
  maxRetries: 2,
  backoffMs: 0,
};

async function testNormalProof() {
  let written = '';
  const proof = await runCanaryWriteReadProof({
    sheetCode: 'H01',
    runId: 'run-ok',
    config,
    now: () => new Date('2026-07-07T00:00:00.000Z'),
    nowMs: () => 1000,
    sleep: async () => {},
    writeNonce: async (nonce) => { written = nonce; },
    fetchCanary: async () => ({ _ragicId: '999', '3000935': 'ZZ-CANARY', '3009999': written }),
    fetchSnapshot: async () => [
      { _ragicId: '999', '3000935': 'ZZ-CANARY', '3009999': written },
      { _ragicId: '1000', '3000935': 'A001', 姓名: '正常員工' },
    ],
  });
  assert.strictEqual(proof.stale_read, false);
  assert.strictEqual(proof.freshness.freshness_verified, true);
  assert.strictEqual(proof.records.length, 1);
  assert.strictEqual(proof.records[0].姓名, '正常員工');
}

async function testStaleSnapshotAborts() {
  const proof = await runCanaryWriteReadProof({
    sheetCode: 'H01',
    runId: 'run-stale',
    config,
    now: () => new Date('2026-07-07T00:00:00.000Z'),
    nowMs: () => 1000,
    sleep: async () => {},
    writeNonce: async () => {},
    fetchCanary: async () => ({ _ragicId: '999', '3000935': 'ZZ-CANARY', '3009999': 'old' }),
    fetchSnapshot: async () => [
      { _ragicId: '999', '3000935': 'ZZ-CANARY', '3009999': 'old' },
      { _ragicId: '1000', '3000935': 'A001', 姓名: '不應套用' },
    ],
  });
  assert.strictEqual(proof.stale_read, true);
  assert.strictEqual(proof.freshness.freshness_verified, false);
  assert.strictEqual(proof.freshness.stale_retries, 2);
  assert.deepStrictEqual(proof.records, []);
}

function testCanaryIsolation() {
  const records = [
    { _ragicId: '999', '3000935': 'A001', 姓名: 'by record id' },
    { _ragicId: '1001', '3000935': 'ZZ-CANARY', 姓名: 'by identifier' },
    { _ragicId: '1002', '3000935': 'A002', 姓名: 'real' },
  ];
  const filtered = filterCanaryRecords(records, config);
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].姓名, 'real');
}

(async () => {
  await testNormalProof();
  await testStaleSnapshotAborts();
  testCanaryIsolation();
  console.log('ragic_freshness_test: PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
