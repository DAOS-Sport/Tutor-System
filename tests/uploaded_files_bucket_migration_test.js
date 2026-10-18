/**
 * 釘住 server/scripts/uploadedFilesToBucket.js 的安全性質。
 *
 * 這支腳本要搬的是家長的匯款證明——1,783 個檔案、334 MB，而且其中一部分是
 * 對帳的唯一憑據。搬錯最多白做工，**刪錯就是永久消失**（2026-07-16 之前那批
 * 就是這樣沒的：198 個 URL 到今天還是 404）。所以危險的預設值不能靠人記得，
 * 要有測試盯著：
 *   1) 不加旗標＝dry-run，不寫 bucket、不寫資料庫
 *   2) checksum 讀回比對通過**之後**才更新資料庫指標（帳本）
 *   3) 刪除是獨立旗標，--apply 不會順便把資料刪掉
 *   4) 比對不符時原始資料一定留著
 *   5) 單筆失敗用 throw 表達，讓呼叫端記錄後繼續，不是中斷整批
 *
 * 全部用假的 pool / bucket，不連資料庫、不出網路。
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../server/scripts/uploadedFilesToBucket.js');
const mig = require(SCRIPT);
const { parseArgs, migrateOne, verifyOne, deleteDbCopyOne, unwrapDownload } = mig;

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const BYTES = Buffer.from('假裝這是一張匯款證明 JPEG');
const KEY = '2026-08/839efb153bd15fe6e7523547.jpg';
const row = () => ({ key: KEY, bytes: Buffer.from(BYTES), byte_size: BYTES.length });

/** 假 bucket：記錄每一次呼叫；store 是「bucket 上實際存了什麼」。 */
function fakeBucket({ corruptOnRead = null, uploadFails = false } = {}) {
  const calls = [];
  const store = new Map();
  return {
    calls,
    store,
    async uploadFromBytes(key, buf) {
      calls.push(['upload', key]);
      if (uploadFails) return { ok: false, error: new Error('boom') };
      store.set(key, Buffer.from(buf));
      return { ok: true, value: null };
    },
    async downloadAsBytes(key) {
      calls.push(['download', key]);
      if (corruptOnRead) return { ok: true, value: [Buffer.from(corruptOnRead)] };
      if (!store.has(key)) return { ok: false, error: new Error('not found') };
      // SDK 真實形狀是 Result<[Buffer]>——value 是陣列，這裡刻意照抄。
      return { ok: true, value: [store.get(key)] };
    },
  };
}

/** 假 pool：記錄每一道 SQL；uploadedFiles 是資料庫裡「當下」的內容。 */
function fakePool({ uploadedFiles = new Map(), ledger = new Map() } = {}) {
  const sqls = [];
  return {
    sqls,
    uploadedFiles,
    ledger,
    async query(sql, params = []) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      sqls.push(s);
      if (/^INSERT INTO uploaded_file_bucket_migration/i.test(s)) {
        ledger.set(params[0], { key: params[0], byte_size: params[1], md5: params[2] });
        return { rowCount: 1, rows: [] };
      }
      if (/^UPDATE uploaded_file_bucket_migration/i.test(s)) {
        const r = ledger.get(params[0]);
        if (r) r.db_deleted_at = new Date();
        return { rowCount: r ? 1 : 0, rows: [] };
      }
      if (/^SELECT bytes, byte_size FROM uploaded_files/i.test(s)) {
        const r = uploadedFiles.get(params[0]);
        return r ? { rowCount: 1, rows: [r] } : { rowCount: 0, rows: [] };
      }
      if (/^DELETE FROM uploaded_files/i.test(s)) {
        const had = uploadedFiles.delete(params[0]);
        return { rowCount: had ? 1 : 0, rows: [] };
      }
      throw new Error('未預期的 SQL：' + s);
    },
  };
}

const wrote = (pool, re) => pool.sqls.some((s) => re.test(s));

// ── 1. 旗標預設值：危險動作一律要明確開啟 ──────────────────────
console.log('旗標預設值');

check('不加任何旗標＝dry-run（不寫 bucket、不寫資料庫）', () => {
  const o = parseArgs([]);
  assert.strictEqual(o.apply, false, '--apply 預設必須是 false');
  assert.strictEqual(o.willWrite, false, '沒給 --apply 就不能寫入');
  assert.strictEqual(o.willDeleteDbRows, false);
  assert.strictEqual(o.mode, 'migrate');
});

check('--apply 只開啟搬移，不會順便刪掉資料庫原始資料', () => {
  const o = parseArgs(['--apply']);
  assert.strictEqual(o.willWrite, true);
  assert.strictEqual(o.willDeleteDbRows, false,
    '--apply 單獨出現時絕不可觸發刪除——刪除必須是另一支旗標');
  assert.strictEqual(o.mode, 'migrate');
});

check('--delete-db-copy 單獨給，仍然只是 dry-run', () => {
  const o = parseArgs(['--delete-db-copy']);
  assert.strictEqual(o.mode, 'delete');
  assert.strictEqual(o.willDeleteDbRows, false, '沒有 --apply 就不能真的刪');
});

check('要真的刪，兩支旗標都得給', () => {
  const o = parseArgs(['--delete-db-copy', '--apply']);
  assert.strictEqual(o.willDeleteDbRows, true);
});

check('--verify-only 是唯讀的，就算加了 --apply 也不寫', () => {
  const o = parseArgs(['--verify-only', '--apply']);
  assert.strictEqual(o.mode, 'verify');
  assert.strictEqual(o.willWrite, false, 'verify 階段永遠不可寫入');
  assert.strictEqual(o.willDeleteDbRows, false);
});

check('分批預設值存在（不會一次把 334 MB 全撈進記憶體）', () => {
  const o = parseArgs([]);
  assert.ok(o.batch > 0 && o.batch <= 100, '批次大小要有合理預設，實得 ' + o.batch);
  assert.strictEqual(parseArgs(['--batch=5']).batch, 5);
  assert.strictEqual(parseArgs(['--limit=20']).limit, 20);
  assert.strictEqual(parseArgs(['--limit=abc']).limit, null, '壞值不可變成 NaN 傳下去');
  assert.strictEqual(parseArgs(['--limit=-3']).limit, null, '負數不可通過');
});

// ── 2. 搬移：驗證通過才更新指標 ────────────────────────────────
(async () => {
  console.log('\n搬移階段');

  await checkAsync('dry-run 不碰 bucket、也不碰資料庫', async () => {
    const bucket = fakeBucket();
    const pool = fakePool();
    const r = await migrateOne({ row: row(), bucket, pool, apply: false });
    assert.strictEqual(r.status, 'dry-run');
    assert.deepStrictEqual(bucket.calls, [], 'dry-run 不可以呼叫 bucket');
    assert.deepStrictEqual(pool.sqls, [], 'dry-run 不可以下任何 SQL');
  });

  await checkAsync('成功路徑的順序是 上傳 → 讀回 → 才寫帳本', async () => {
    const bucket = fakeBucket();
    const pool = fakePool();
    const r = await migrateOne({ row: row(), bucket, pool, apply: true });
    assert.strictEqual(r.status, 'migrated');
    assert.deepStrictEqual(bucket.calls, [['upload', KEY], ['download', KEY]],
      '必須讀回來驗證，不能只信 upload 回報的 ok');
    assert.strictEqual(pool.sqls.length, 1, '只該有帳本那一道寫入');
    assert.ok(/^INSERT INTO uploaded_file_bucket_migration/i.test(pool.sqls[0]));
    assert.strictEqual(pool.ledger.get(KEY).md5, md5(BYTES), '帳本記的 md5 要是來源的 md5');
  });

  await checkAsync('checksum 不符 → 丟錯，而且帳本一個字都不寫', async () => {
    const bucket = fakeBucket({ corruptOnRead: '被改過的內容' });
    const pool = fakePool();
    await assert.rejects(
      () => migrateOne({ row: row(), bucket, pool, apply: true }),
      (e) => e.code === 'CHECKSUM_MISMATCH',
      '讀回內容不一致時必須 throw',
    );
    assert.strictEqual(pool.ledger.size, 0, '驗證沒過就寫帳本＝之後會誤刪原始資料');
    assert.ok(!wrote(pool, /INSERT INTO uploaded_file_bucket_migration/i));
  });

  await checkAsync('上傳失敗 → 不會去讀回、也不會寫帳本', async () => {
    const bucket = fakeBucket({ uploadFails: true });
    const pool = fakePool();
    await assert.rejects(
      () => migrateOne({ row: row(), bucket, pool, apply: true }),
      (e) => e.code === 'BUCKET_UPLOAD_FAILED',
    );
    assert.deepStrictEqual(bucket.calls, [['upload', KEY]]);
    assert.strictEqual(pool.ledger.size, 0);
  });

  await checkAsync('搬移階段永遠不會刪 uploaded_files', async () => {
    const bucket = fakeBucket();
    const files = new Map([[KEY, { bytes: Buffer.from(BYTES), byte_size: BYTES.length }]]);
    const pool = fakePool({ uploadedFiles: files });
    await migrateOne({ row: row(), bucket, pool, apply: true });
    assert.ok(!wrote(pool, /DELETE FROM uploaded_files/i), '搬移階段不可以有 DELETE');
    assert.strictEqual(files.size, 1, '原始資料必須原封不動留著');
  });

  // ── 3. 刪除：獨立階段、獨立旗標、刪之前重新比對 ──────────────
  console.log('\n刪除階段');

  const seeded = () => {
    const bucket = fakeBucket();
    bucket.store.set(KEY, Buffer.from(BYTES));
    const files = new Map([[KEY, { bytes: Buffer.from(BYTES), byte_size: BYTES.length }]]);
    const pool = fakePool({ uploadedFiles: files });
    const ledgerRow = { key: KEY, byte_size: BYTES.length, md5: md5(BYTES) };
    return { bucket, pool, files, ledgerRow };
  };

  await checkAsync('刪除的 dry-run 不會刪掉任何東西', async () => {
    const { bucket, pool, files, ledgerRow } = seeded();
    const r = await deleteDbCopyOne({ ledgerRow, bucket, pool, apply: false });
    assert.strictEqual(r.status, 'dry-run-delete');
    assert.ok(!wrote(pool, /DELETE FROM uploaded_files/i));
    assert.strictEqual(files.size, 1, 'dry-run 之後原始資料必須還在');
  });

  await checkAsync('刪除前會重新比對 bucket 與資料庫當下的內容（不採信帳本）', async () => {
    const { bucket, pool, files, ledgerRow } = seeded();
    const r = await deleteDbCopyOne({ ledgerRow, bucket, pool, apply: true });
    assert.strictEqual(r.status, 'deleted');
    assert.ok(bucket.calls.some(([op]) => op === 'download'),
      '必須真的從 bucket 抓一次回來比對');
    assert.ok(wrote(pool, /SELECT bytes, byte_size FROM uploaded_files/i),
      '必須讀資料庫當下的 bytes，而不是拿帳本的 md5 當真');
    assert.strictEqual(files.size, 0, '比對通過才刪');
  });

  await checkAsync('bucket 內容與資料庫不符 → 拒絕刪除，原始資料留著', async () => {
    const { pool, files, ledgerRow } = seeded();
    const bucket = fakeBucket({ corruptOnRead: '不一樣的位元組' });
    await assert.rejects(
      () => deleteDbCopyOne({ ledgerRow, bucket, pool, apply: true }),
      (e) => e.code === 'CHECKSUM_MISMATCH',
    );
    assert.ok(!wrote(pool, /DELETE FROM uploaded_files/i), '比對不符還刪＝資料永久消失');
    assert.strictEqual(files.size, 1);
  });

  await checkAsync('帳本 md5 與資料庫現況漂移 → 拒絕刪除', async () => {
    const { bucket, pool, files } = seeded();
    const drifted = { key: KEY, byte_size: BYTES.length, md5: 'ffffffffffffffffffffffffffffffff' };
    await assert.rejects(
      () => deleteDbCopyOne({ ledgerRow: drifted, bucket, pool, apply: true }),
      (e) => e.code === 'CHECKSUM_MISMATCH' || e.code === 'LEDGER_DRIFT',
    );
    assert.strictEqual(files.size, 1);
  });

  await checkAsync('資料庫已經沒有這一列 → 視為已刪，不算失敗', async () => {
    const { bucket, ledgerRow } = seeded();
    const pool = fakePool();
    const r = await deleteDbCopyOne({ ledgerRow, bucket, pool, apply: true });
    assert.strictEqual(r.status, 'already-deleted');
  });

  // ── 4. 重驗階段：純讀 ────────────────────────────────────────
  console.log('\n重驗階段');

  await checkAsync('verifyOne 只讀 bucket，不下任何 SQL', async () => {
    const { bucket, pool, ledgerRow } = seeded();
    const r = await verifyOne({ ledgerRow, bucket, pool });
    assert.strictEqual(r.status, 'verified');
    assert.deepStrictEqual(pool.sqls, [], '重驗不可以寫入任何東西');
  });

  await checkAsync('verifyOne 抓得到 bucket 上被改動的檔案', async () => {
    const { ledgerRow } = seeded();
    const bucket = fakeBucket({ corruptOnRead: 'x' });
    await assert.rejects(() => verifyOne({ ledgerRow, bucket }), (e) => e.code === 'CHECKSUM_MISMATCH');
  });

  // ── 5. SDK 回傳形狀 ─────────────────────────────────────────
  console.log('\nSDK 回傳形狀');

  check('downloadAsBytes 的 Result<[Buffer]> 陣列包裝要正確拆開', () => {
    const buf = Buffer.from('abc');
    assert.ok(unwrapDownload({ ok: true, value: [buf] }).equals(buf),
      '拆錯的話 md5 會算到 Buffer.from(array) 的垃圾值，而且不會報錯');
    assert.ok(unwrapDownload({ ok: true, value: buf }).equals(buf));
  });

  check('ok:false 一律當失敗，不可回空 Buffer', () => {
    assert.throws(() => unwrapDownload({ ok: false, error: new Error('x') }),
      (e) => e.code === 'BUCKET_DOWNLOAD_FAILED');
    assert.throws(() => unwrapDownload(null), (e) => e.code === 'BUCKET_DOWNLOAD_FAILED');
  });

  // ── 6. 結構性守衛 ───────────────────────────────────────────
  console.log('\n結構性守衛');

  const src = fs.readFileSync(SCRIPT, 'utf8');

  check('整份腳本只有一處 DELETE FROM uploaded_files', () => {
    const n = (src.match(/DELETE FROM uploaded_files/gi) || []).length;
    assert.strictEqual(n, 1, '刪除路徑必須只有一條，實得 ' + n + ' 處');
  });

  check('單筆失敗是記錄後繼續，不是中斷整批', () => {
    const i = src.indexOf('const note =');
    assert.ok(i > 0, '找不到失敗記錄函式');
    assert.ok(/out\.failed \+= 1/.test(src.slice(i, i + 400)),
      '失敗要計數並收集，而不是往外丟');
    assert.ok(!/for \(const row of batch\) \{\s*[^}]*await migrateOne[^}]*\}\s*\n/.test(src)
      || /catch \(e\) \{\s*\n\s*note\(/.test(src),
      '批次迴圈內必須有 try/catch 接住單筆失敗');
  });

  check('被 require 進來時不會自己跑起來（否則測試會去連正式庫）', () => {
    assert.ok(/require\.main === module/.test(src), '缺少 require.main 守衛');
  });

  check('bucket preflight 不回顯 SDK 原始錯誤（避免憑證寫進 log）', () => {
    const i = src.indexOf('async function preflightBucket');
    const body = src.slice(i, src.indexOf('\n}', i));
    assert.ok(i > 0, '找不到 preflightBucket');
    assert.ok(!/why:\s*raw|\+\s*raw|\$\{raw\}/.test(body),
      'why 欄位不可含 raw 原文——同 objectStorage.classifyStorageFailure 的理由');
  });

  console.log(failures ? `\n${failures} FAILED` : '\nuploaded_files_bucket_migration: ALL PASS');
  process.exitCode = failures ? 1 : 0;
})();
