// PostgreSQL 耐久 upload driver（uploaded_files）與 read-through 契約。
// 背景：production bucket 未開通時曾降級本機磁碟，Autoscale 換實例／重部署即讓
// 家長匯款證明 404、objectExists 跨實例驗證失敗——對帳清單因此讀不到照片。
// 本測試以注入的 fake pool / fake driver 驗證：
//   1) DbDriver 產生的 URL 與既有 PROOF_URL_RE 相容（上傳後可通過 parseProofInput）
//   2) replit driver 下 bucket miss 仍可從 DB 讀回（driver 切換不可讓既有 URL 404）
//   3) fail closed：bucket lookup error 且 DB 無此檔時必須 throw，不可誤判存在／不存在
const assert = require('assert');

const objectStorage = require('../server/services/objectStorage');
const { PROOF_URL_RE } = require('../server/services/paymentProof');

const { createDbDriver, sourceExists } = objectStorage.__test__;

function fakePool(store) {
  return {
    async query(sql, params) {
      if (/^INSERT INTO uploaded_files/.test(sql.trim())) {
        const [key, mimeType, bytes, byteSize] = params;
        store.set(key, { mime_type: mimeType, bytes, byte_size: byteSize });
        return { rowCount: 1, rows: [] };
      }
      if (/SELECT 1 FROM uploaded_files/.test(sql)) {
        return store.has(params[0]) ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
      }
      if (/SELECT bytes, mime_type FROM uploaded_files/.test(sql)) {
        const row = store.get(params[0]);
        return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

async function testDbDriverRoundTrip() {
  const store = new Map();
  const driver = createDbDriver(() => fakePool(store));
  const buffer = Buffer.from('fake-jpeg-bytes');

  const saved = await driver.saveBuffer({ buffer, ext: '.jpg', mimeType: 'image/jpeg' });
  assert.ok(
    PROOF_URL_RE.test(saved.url),
    `DB driver URL 必須通過既有 proof URL 驗證：${saved.url}`,
  );

  const key = saved.url.slice('/uploads/'.length);
  assert.strictEqual(await driver.exists(key), true, '剛寫入的檔案必須立即可驗證');
  assert.strictEqual(await driver.exists('2026-07/no-such-file.jpg'), false);

  const read = await driver.readFile(key);
  assert.ok(read && Buffer.compare(read.buffer, buffer) === 0, '讀回的 bytes 必須與上傳一致');
  assert.strictEqual(read.mimeType, 'image/jpeg');
  assert.strictEqual(await driver.readFile('2026-07/no-such-file.jpg'), null);
}

async function testReadThroughAcrossSources() {
  const KEY = '2026-07/0123456789abcdef01234567.jpg';
  const dbHit = {
    name: 'db',
    exists: async (key) => key === KEY,
    readFile: async (key) => (key === KEY ? { buffer: Buffer.from('db-bytes'), mimeType: 'image/jpeg' } : null),
  };
  const dbMiss = { name: 'db', exists: async () => false, readFile: async () => null };
  const bucketMiss = { name: 'replit', exists: async () => false, openReadStream: () => null };
  const bucketBroken = {
    name: 'replit',
    exists: async () => {
      const err = new Error('物件儲存查詢失敗');
      err.code = 'OBJECT_STORAGE_LOOKUP_FAILED';
      throw err;
    },
    openReadStream: () => null,
  };

  // bucket miss → DB 命中：切回 bucket driver 後，DB 時期的檔案仍存在
  assert.strictEqual(
    await sourceExists(KEY, { driver: bucketMiss, dbDriver: dbHit }),
    true,
    'bucket 無此物件時必須 read-through 到 uploaded_files',
  );
  const served = await objectStorage.openUpload(`/uploads/${KEY}`, { driver: bucketMiss, dbDriver: dbHit });
  assert.strictEqual(served?.kind, 'buffer', 'bucket miss 時必須以 DB buffer 回應');
  assert.strictEqual(served.mimeType, 'image/jpeg');

  // bucket 異常但 DB 命中：照片仍可驗證與顯示
  assert.strictEqual(
    await sourceExists(KEY, { driver: bucketBroken, dbDriver: dbHit }),
    true,
    'bucket lookup 異常但 DB 有檔案時不可 fail',
  );

  // fail closed：bucket 異常且 DB 無此檔 → throw（parseProofInput 轉 503）
  await assert.rejects(
    () => sourceExists(KEY, { driver: bucketBroken, dbDriver: dbMiss }),
    (error) => error.code === 'OBJECT_STORAGE_LOOKUP_FAILED',
    'bucket 異常且 DB miss 必須 fail closed，不可回 false 誤判成偽造 URL',
  );
  await assert.rejects(
    () => objectStorage.openUpload(`/uploads/${KEY}`, { driver: bucketBroken, dbDriver: dbMiss }),
    (error) => error.code === 'OBJECT_STORAGE_LOOKUP_FAILED',
  );

  // 兩來源皆 miss → 單純不存在
  assert.strictEqual(await sourceExists(KEY, { driver: bucketMiss, dbDriver: dbMiss }), false);
  assert.strictEqual(await objectStorage.openUpload(`/uploads/${KEY}`, { driver: bucketMiss, dbDriver: dbMiss }), null);

  // db driver 直接命中
  assert.strictEqual(await sourceExists(KEY, { driver: dbHit, dbDriver: dbHit }), true);
  const direct = await objectStorage.openUpload(`/uploads/${KEY}`, { driver: dbHit, dbDriver: dbHit });
  assert.strictEqual(direct?.kind, 'buffer');

  // 路徑穿越／非 /uploads URL 一律拒絕
  assert.strictEqual(await objectStorage.openUpload('/uploads/../etc/passwd', { driver: dbHit, dbDriver: dbHit }), null);
  assert.strictEqual(await objectStorage.objectExists('/etc/passwd'), false);
}

(async () => {
  await testDbDriverRoundTrip();
  await testReadThroughAcrossSources();
  console.log('object_storage_db_fallback_test: PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
