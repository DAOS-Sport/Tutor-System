const assert = require('assert');

const objectStorage = require('../server/services/objectStorage');
const { parseProofInput } = require('../server/services/paymentProof');

const VALID_URL = '/uploads/2026-07/0123456789abcdef01234567.jpg';
const VALID_KEY = '2026-07/0123456789abcdef01234567.jpg';

async function main() {
  const calls = [];
  const foundDriver = objectStorage.__test__.createReplitDriver(() => ({
    exists: async (key) => {
      calls.push(key);
      return { ok: true, value: true };
    },
  }));
  assert.strictEqual(await foundDriver.exists(VALID_KEY), true);
  assert.deepStrictEqual(calls, [VALID_KEY], 'production adapter must call SDK exists with the object key');

  const missingDriver = objectStorage.__test__.createReplitDriver(() => ({
    exists: async () => ({ ok: true, value: false }),
  }));
  assert.strictEqual(await missingDriver.exists(VALID_KEY), false, 'well-formed but missing key is not accepted');

  const errorDriver = objectStorage.__test__.createReplitDriver(() => ({
    exists: async () => ({ ok: false, error: { message: 'sensitive SDK detail' } }),
  }));
  await assert.rejects(
    () => errorDriver.exists(VALID_KEY),
    (error) => error.code === 'OBJECT_STORAGE_LOOKUP_FAILED'
      && !error.message.includes('sensitive SDK detail'),
    'SDK lookup errors must fail closed without leaking provider details',
  );

  const accepted = await parseProofInput(
    { payment_proof_url: VALID_URL },
    { exists: async () => true },
  );
  assert.strictEqual(accepted.value, VALID_URL, 'existing proof is accepted');

  const missing = await parseProofInput(
    { payment_proof_url: VALID_URL },
    { exists: async () => false },
  );
  assert.strictEqual(missing.code, 'PAYMENT_PROOF_INVALID');
  assert.strictEqual(missing.status, 400);

  const lookupError = await parseProofInput(
    { payment_proof_url: VALID_URL },
    { exists: async () => { throw new Error('provider unavailable'); } },
  );
  assert.strictEqual(lookupError.code, 'PAYMENT_PROOF_LOOKUP_FAILED');
  assert.strictEqual(lookupError.status, 503, 'lookup failure must not be reported as a successful upload');

  assert.throws(
    () => objectStorage.assertProductionStorageConfigured({ nodeEnv: 'production', actualDriver: 'local' }),
    (error) => error.code === 'PRODUCTION_LOCAL_STORAGE_FORBIDDEN',
  );
  assert.strictEqual(
    objectStorage.assertProductionStorageConfigured({ nodeEnv: 'development', actualDriver: 'local' }),
    true,
    'development may use local test storage',
  );
  assert.strictEqual(await objectStorage.assertProductionStorageReady({
    nodeEnv: 'production',
    actualDriver: 'replit',
    listObjects: async () => ({ ok: true, value: [] }),
  }), true);
  await assert.rejects(
    () => objectStorage.assertProductionStorageReady({
      nodeEnv: 'production',
      actualDriver: 'replit',
      listObjects: async () => ({ ok: false, error: { message: 'credential detail' } }),
    }),
    (error) => error.code === 'PRODUCTION_STORAGE_PREFLIGHT_FAILED'
      && !error.message.includes('credential detail'),
  );

  console.log('object_storage_existence_test: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
