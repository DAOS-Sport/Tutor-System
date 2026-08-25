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

  // ── preflight 訊息：說得出原因，但永遠不回顯原文 ──────────────
  //
  // 兩個相反的失敗都要防：回顯原文會把憑證寫進 log；整個吞掉則讓正式站
  // 降級到 PostgreSQL 跑了六週，沒人知道原因只是「沒有配置 bucket」。
  // 分類字串是本檔寫死的常數，所以兩者可以同時成立。
  const causeOf = async (listObjects) => {
    try {
      await objectStorage.assertProductionStorageReady({
        nodeEnv: 'production', actualDriver: 'replit', listObjects,
      });
      throw new Error('preflight 應該要失敗');
    } catch (e) { return e.message; }
  };

  assert.match(
    await causeOf(async () => { throw new Error('A bucket name is needed to use Cloud Storage.'); }),
    /尚未配置 bucket/,
    '正式站實際遇到的就是這一種，訊息必須指向「去開通 bucket」',
  );
  assert.match(
    await causeOf(async () => ({ ok: false, error: { message: 'permission denied' } })),
    /沒有存取權限/,
  );
  assert.match(
    await causeOf(async () => { throw new Error('ETIMEDOUT'); }),
    /連線不到儲存服務/,
  );
  assert.match(
    await causeOf(async () => ({ ok: false, error: { message: 'something unrecognised' } })),
    /未知原因/,
    '認不出來的一律歸為未知 —— 白名單式，不能反過來預設回顯',
  );

  // 最重要的一條：任何形式的原文都不得出現在訊息裡。
  for (const secret of ['sk_live_LEAKME', 'hunter2', 'Bearer abc.def.ghi']) {
    const msg = await causeOf(async () => { throw new Error(`auth failed with ${secret}`); });
    assert.ok(!msg.includes(secret), `preflight 訊息洩漏了原文片段：${secret}`);
  }

  console.log('object_storage_existence_test: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
