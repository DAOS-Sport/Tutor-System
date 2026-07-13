const assert = require('assert');

const groupOrders = require('../server/routes/groupOrders');
const adminGroupOrders = require('../server/routes/admin/groupOrders');

const { parseProofInput, isSamePaymentPayload } = groupOrders.__test__;
const { genEnrollmentId } = adminGroupOrders.__test__;
const VALID_PROOF = '/uploads/2026-07/0123456789abcdef01234567.jpg';

async function testProofInput() {
  const stored = async (url) => url === VALID_PROOF;
  const omitted = await parseProofInput({}, { exists: stored });
  assert.strictEqual(omitted.supplied, false);
  assert.strictEqual(omitted.clear, false);
  const blank = await parseProofInput({ payment_proof_url: '' }, { exists: stored });
  assert.strictEqual(blank.supplied, false);
  const accepted = await parseProofInput({ payment_proof_url: VALID_PROOF }, { exists: stored });
  assert.strictEqual(accepted.supplied, true);
  assert.strictEqual(accepted.value, VALID_PROOF);
  const invalid = await parseProofInput(
    { payment_proof_url: '/uploads/2026-07/not-owned.png' },
    { exists: stored },
  );
  assert.strictEqual(invalid.supplied, true);
  assert.ok(invalid.error, 'invalid proof must be rejected rather than silently dropped');
  const clear = await parseProofInput(
    { delete_payment_proof: true },
    { exists: stored, allowClear: true },
  );
  assert.strictEqual(clear.clear, true, 'only an explicit delete action may clear a proof');
}

function testRetryAndPreservationRules() {
  const member = { payment_proof_url: VALID_PROOF, transfer_last_5: '12345' };
  assert.strictEqual(
    isSamePaymentPayload(member, { supplied: true, value: VALID_PROOF, last5: '12345' }),
    true,
    'same request retry should be idempotent',
  );
  assert.strictEqual(
    isSamePaymentPayload(member, { value: '/uploads/2026-07/aaaaaaaaaaaaaaaaaaaaaaaa.png', last5: '12345' }),
    false,
    'a different proof must not be treated as an idempotent retry',
  );
  assert.strictEqual(
    isSamePaymentPayload(member, { value: null, last5: '' }),
    false,
    'omitted payment fields do not authorize a write or clear existing proof',
  );
}

function testGroupEnrollmentIdsHaveEnoughEntropy() {
  const ids = new Set();
  for (let i = 0; i < 5000; i += 1) ids.add(genEnrollmentId());
  assert.strictEqual(ids.size, 5000, 'group approval IDs must not collide under a multi-member burst');
}

(async () => {
  await testProofInput();
  testRetryAndPreservationRules();
  testGroupEnrollmentIdsHaveEnoughEntropy();
  console.log('group_payment_proof_test: PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
