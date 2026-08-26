// 把 uploaded_files（PostgreSQL bytea）裡的檔案搬回 Replit Object Storage bucket。
//
// ── 為什麼有這一批檔案 ──
// 2026-07-16 00:30 UTC 起，正式站的 bucket preflight 失敗，server/index.js 依設計
// 降級到 PostgreSQL 耐久 driver（uploaded_files），家長的匯款證明才沒有再遺失。
// 失敗原因不是程式，是**這個 Repl 從來沒有開通過 Object Storage**——sidecar 的
// /object-storage/default-bucket 回 {"bucketId":""}，SDK 於是丟
// 「A bucket name is needed to use Cloud Storage.」。要先在 Replit 介面把 bucket 開出來，
// 這支才有地方可搬（見本檔最下方「前置作業」）。
//
// ── 為什麼搬回去之後不用改任何 URL ──
// DbDriver 與 ReplitDriver 用的是**同一組 key**（`YYYY-MM/<hex>.<ext>`），對外 URL
// 一律是 `/uploads/<key>`。所以把同一個 key 放進 bucket，admin_enrollments.
// payment_proof_url 之類的欄位一個字都不用動；objectStorage.openUpload 在 replit
// driver 下本來就是「先查 bucket，miss 才回頭讀 uploaded_files」的 read-through。
// 這也是為什麼搬移可以慢慢來、可以中斷：搬到一半的狀態下，搬好的走 bucket、
// 還沒搬的走 DB，兩邊的 URL 都是通的。
//
// ── 進度帳本 ──
// 進度記在 uploaded_file_bucket_migration，不是記在 uploaded_files 上：
//   1) 不動 347 MB 的熱表 schema；
//   2) 第二階段刪掉 uploaded_files 的原始 bytea 之後，帳本仍留著「搬了什麼、
//      當時的 md5 是多少、什麼時候刪的」——刪除動作要有稽核痕跡。
// 續跑就是重跑同一道指令：已經在帳本裡的 key 會被 LEFT JOIN 濾掉。
//
// ── 兩個階段是分開的，而且刻意麻煩 ──
//   階段一 搬移（--apply）        ：上傳 → 讀回 → 比對 checksum → 通過才寫帳本。
//                                  **完全不碰 uploaded_files**，原始 bytea 原封不動。
//   階段二 刪除（--delete-db-copy）：另一支旗標、另一趟。刪之前重新從 bucket 抓一次、
//                                  跟資料庫裡**當下**的 bytes 重算 md5 比對，不採信帳本。
// 之所以不合併：搬移出錯最多是白做工，刪除出錯是家長的匯款證明永久消失。
// 建議中間隔幾天，確認 bucket 上的檔案在正式站真的讀得到，再走階段二。
//
// ── 用法 ──
//   node scripts/uploadedFilesToBucket.js                        # dry-run（預設，不寫任何東西）
//   node scripts/uploadedFilesToBucket.js --limit=20             # 只看前 20 筆要做什麼
//   node scripts/uploadedFilesToBucket.js --apply --limit=20     # 先小批量真的搬
//   node scripts/uploadedFilesToBucket.js --apply                # 全部搬
//   node scripts/uploadedFilesToBucket.js --verify-only          # 只讀重驗帳本（不寫）
//   node scripts/uploadedFilesToBucket.js --delete-db-copy       # 刪除階段的 dry-run
//   node scripts/uploadedFilesToBucket.js --delete-db-copy --apply   # 真的刪 DB 原始資料
//
// ⚠️ 「資料在哪裡就在哪裡跑」：待搬的那批在正式庫。DEV 跑只會處理 DEV 的資料。
// ⚠️ --apply 會真的寫進 bucket；--delete-db-copy --apply 會真的刪掉資料庫裡的 bytea。
'use strict';

const crypto = require('crypto');

const LEDGER_TABLE = 'uploaded_file_bucket_migration';

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  key            text PRIMARY KEY,
  byte_size      integer     NOT NULL,
  md5            text        NOT NULL,
  verified_at    timestamptz NOT NULL DEFAULT now(),
  db_deleted_at  timestamptz
)`;

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// SDK 的 downloadAsBytes 回的是 Result<[Buffer]>（value 是**陣列**）。
// 直接拿 value 去算 md5 會得到 Buffer.from(array) 的垃圾值，而且不會報錯——
// 那種錯的後果是「驗證永遠失敗」或更糟「驗證永遠通過」，所以在這裡收斂一次。
function unwrapDownload(result) {
  if (!result || result.ok !== true) {
    const reason = result && result.error ? String(result.error.message || result.error) : '無回應';
    const err = new Error('bucket 讀回失敗');
    err.code = 'BUCKET_DOWNLOAD_FAILED';
    err.reason = reason;
    throw err;
  }
  const v = result.value;
  const buf = Array.isArray(v) ? v[0] : v;
  if (!Buffer.isBuffer(buf)) {
    const err = new Error('bucket 讀回的不是 Buffer');
    err.code = 'BUCKET_DOWNLOAD_MALFORMED';
    throw err;
  }
  return buf;
}

function mismatchError(key, expected, got) {
  const err = new Error(
    `checksum 不符：${key} 期望 ${expected.md5}/${expected.size}B，`
    + `bucket 讀回 ${got.md5}/${got.size}B`,
  );
  err.code = 'CHECKSUM_MISMATCH';
  return err;
}

/**
 * 搬一個檔案：上傳 → **讀回** → 比對 checksum → 通過才寫帳本。
 *
 * 讀回這一步不能省。uploadFromBytes 回 ok:true 只代表「SDK 認為送出去了」，
 * 不代表 bucket 上那份位元組跟手上這份一樣。帳本一旦寫下去，階段二就會拿它
 * 當「可以刪 DB 原始資料」的依據——所以帳本必須是「親自讀回來比對過」的結果，
 * 不能是「上傳 API 說成功」的結果。
 *
 * 任何一步失敗都 throw，由呼叫端記錄後**繼續下一筆**（不中斷整批）。
 */
async function migrateOne({ row, bucket, pool, apply }) {
  const expected = { md5: md5(row.bytes), size: row.bytes.length };

  if (!apply) {
    return { key: row.key, status: 'dry-run', bytes: expected.size, md5: expected.md5 };
  }

  const uploaded = await bucket.uploadFromBytes(row.key, row.bytes);
  if (!uploaded || uploaded.ok !== true) {
    const reason = uploaded && uploaded.error ? String(uploaded.error.message || uploaded.error) : '無回應';
    const err = new Error('bucket 上傳失敗');
    err.code = 'BUCKET_UPLOAD_FAILED';
    err.reason = reason;
    throw err;
  }

  const readBack = unwrapDownload(await bucket.downloadAsBytes(row.key));
  const got = { md5: md5(readBack), size: readBack.length };
  if (got.md5 !== expected.md5 || got.size !== expected.size) {
    // 刻意不刪 bucket 上那份壞的：留著讓人看得到現場。重跑會覆寫同一個 key。
    throw mismatchError(row.key, expected, got);
  }

  // ── 只有走到這裡才動資料庫 ──
  await pool.query(
    `INSERT INTO ${LEDGER_TABLE} (key, byte_size, md5)
          VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET byte_size = EXCLUDED.byte_size,
                                     md5        = EXCLUDED.md5,
                                     verified_at = now()`,
    [row.key, expected.size, expected.md5],
  );

  return { key: row.key, status: 'migrated', bytes: expected.size, md5: expected.md5 };
}

/**
 * 重驗一筆帳本紀錄：純讀，任何模式下都不寫入。
 * 與帳本記的 md5 比對——這是搬完之後、決定要不要進入刪除階段時的體檢。
 */
async function verifyOne({ ledgerRow, bucket }) {
  const buf = unwrapDownload(await bucket.downloadAsBytes(ledgerRow.key));
  const got = { md5: md5(buf), size: buf.length };
  if (got.md5 !== ledgerRow.md5 || got.size !== ledgerRow.byte_size) {
    throw mismatchError(ledgerRow.key, { md5: ledgerRow.md5, size: ledgerRow.byte_size }, got);
  }
  return { key: ledgerRow.key, status: 'verified', bytes: got.size };
}

/**
 * 階段二：刪掉 uploaded_files 裡的原始 bytea。
 *
 * 這裡刻意**不採信帳本**。帳本是階段一自己寫的，拿產生者自己的紀錄當「可以刪了」
 * 的證據，等於沒有檢查。所以每一筆都重新：
 *   1) 從 bucket 抓下來；
 *   2) 讀資料庫**當下**的 bytes；
 *   3) 兩邊重算 md5，一致才刪。
 * 資料庫已經沒有這一列（前一趟刪過了）→ 視為 already-deleted，不算失敗。
 * 任何不一致 → refuse，記成失敗，原始資料留著。
 */
async function deleteDbCopyOne({ ledgerRow, bucket, pool, apply }) {
  const live = await pool.query(
    'SELECT bytes, byte_size FROM uploaded_files WHERE key = $1',
    [ledgerRow.key],
  );
  if (!live.rowCount) {
    if (apply) {
      await pool.query(
        `UPDATE ${LEDGER_TABLE} SET db_deleted_at = coalesce(db_deleted_at, now()) WHERE key = $1`,
        [ledgerRow.key],
      );
    }
    return { key: ledgerRow.key, status: 'already-deleted', bytes: 0 };
  }

  const dbBytes = live.rows[0].bytes;
  const dbSum = { md5: md5(dbBytes), size: dbBytes.length };

  const buf = unwrapDownload(await bucket.downloadAsBytes(ledgerRow.key));
  const bucketSum = { md5: md5(buf), size: buf.length };

  // bucket 對 DB：這是唯一能證明「刪掉 DB 這份不會掉資料」的比對。
  if (bucketSum.md5 !== dbSum.md5 || bucketSum.size !== dbSum.size) {
    throw mismatchError(ledgerRow.key, dbSum, bucketSum);
  }
  // 順手抓帳本漂移（例如有人手改過帳本，或搬移後檔案被重新上傳過）。
  if (dbSum.md5 !== ledgerRow.md5) {
    const err = new Error(`帳本 md5 與資料庫現況不符：${ledgerRow.key}`);
    err.code = 'LEDGER_DRIFT';
    throw err;
  }

  if (!apply) {
    return { key: ledgerRow.key, status: 'dry-run-delete', bytes: dbSum.size };
  }

  await pool.query('DELETE FROM uploaded_files WHERE key = $1', [ledgerRow.key]);
  await pool.query(
    `UPDATE ${LEDGER_TABLE} SET db_deleted_at = now() WHERE key = $1`,
    [ledgerRow.key],
  );
  return { key: ledgerRow.key, status: 'deleted', bytes: dbSum.size };
}

/**
 * 旗標解析。安全預設全部集中在這裡，測試也盯這裡：
 *   apply         預設 false —— 不加就是 dry-run，不寫 bucket 也不寫資料庫
 *   deleteDbCopy  預設 false —— 刪除是獨立旗標，不會被 --apply 順便帶出來
 * 兩者是 AND：真的刪資料要 `--delete-db-copy --apply` 兩個都給。
 */
function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const num = (k, dflt) => {
    const hit = args.find((a) => a.startsWith(`--${k}=`));
    const v = hit ? Number(hit.split('=')[1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const apply = args.includes('--apply');
  const deleteDbCopy = args.includes('--delete-db-copy');
  const verifyOnly = args.includes('--verify-only');
  return {
    apply,
    deleteDbCopy,
    verifyOnly,
    // verify 永遠不寫；delete 需要兩支旗標；其餘是搬移。
    mode: verifyOnly ? 'verify' : (deleteDbCopy ? 'delete' : 'migrate'),
    willWrite: apply && !verifyOnly,
    willDeleteDbRows: apply && deleteDbCopy && !verifyOnly,
    limit: num('limit', null),
    batch: num('batch', 25),
    gap: Number.isFinite(Number((args.find((a) => a.startsWith('--gap=')) || '').split('=')[1]))
      ? Number(args.find((a) => a.startsWith('--gap=')).split('=')[1])
      : 0,
  };
}

// ── 以下只在直接執行時跑；被 require 進測試時不連 DB、不碰 bucket ──

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

function getBucketClient() {
  const { Client } = require('@replit/object-storage');
  const bucketId = process.env.OBJECT_STORAGE_BUCKET_ID
    || process.env.REPLIT_OBJECT_STORAGE_BUCKET;
  return bucketId ? new Client({ bucketId }) : new Client();
}

// bucket 還沒開通就整趟不用跑。這裡把 SDK 的原始訊息**分類**後才輸出，
// 不回顯原文——sidecar 的錯誤字串可能夾帶憑證片段（同 objectStorage.js 的理由）。
async function preflightBucket(bucket) {
  let raw = '';
  try {
    const r = await bucket.list({ maxResults: 1 });
    if (r && r.ok === true) return { ok: true };
    raw = r && r.error ? String(r.error.message || r.error) : '';
  } catch (e) {
    raw = String((e && e.message) || e);
  }
  if (/bucket name is needed|no bucket|bucket.*(not found|does not exist)/i.test(raw)) {
    return { ok: false, why: '這個 Repl 尚未開通 Object Storage（sidecar 回傳的 default bucket 是空字串）' };
  }
  if (/permission|denied|unauthor|forbidden|401|403/i.test(raw)) {
    return { ok: false, why: 'bucket 存在但沒有存取權限' };
  }
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network/i.test(raw)) {
    return { ok: false, why: '連線不到儲存服務（暫時性網路問題）' };
  }
  return { ok: false, why: '未知原因（詳見 Replit Object Storage 設定）' };
}

async function ledgerExists(pool) {
  const r = await pool.query(`SELECT to_regclass('public.${LEDGER_TABLE}') AS t`);
  return Boolean(r.rows[0] && r.rows[0].t);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { pool } = require('../models/db');

  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d;
  const bucket = getBucketClient();

  const pre = await preflightBucket(bucket);
  console.log('資料庫：' + db);
  console.log('階段：' + ({ migrate: '搬移', verify: '重驗（唯讀）', delete: '刪除資料庫原始資料' })[opts.mode]);
  console.log('模式：' + (opts.willDeleteDbRows
    ? '** 真的刪除 uploaded_files 的原始資料 **'
    : (opts.willWrite ? '** 真的寫入 bucket **' : 'dry-run（不寫入任何東西）')));
  console.log('bucket preflight：' + (pre.ok ? 'OK' : '失敗 — ' + pre.why));
  console.log('');

  if (!pre.ok) {
    console.error('bucket 不可用，整趟中止（沒有動任何資料）。');
    console.error('先在 Replit 介面開通 Object Storage：左側 Tools → 搜尋 "Object Storage" → Create a bucket。');
    await pool.end();
    process.exit(1);
    return;
  }

  const hasLedger = await ledgerExists(pool);
  if (!hasLedger) {
    if (!opts.willWrite) {
      console.log(`（帳本 ${LEDGER_TABLE} 尚未建立；dry-run 不建表，以下視為全部未搬移）`);
    } else {
      await pool.query(LEDGER_DDL);
      console.log(`已建立進度帳本 ${LEDGER_TABLE}`);
    }
  }

  const out = { ok: 0, failed: 0, skipped: 0, bytes: 0, errors: [] };
  const t0 = Date.now();
  let processed = 0;

  const note = (key, e) => {
    out.failed += 1;
    out.errors.push(`${key}：${e.code ? e.code + ' ' : ''}${e.message}${e.reason ? ' | ' + e.reason : ''}`);
    console.warn(`    FAIL ${key} → ${e.code || ''} ${e.message}`);
  };

  if (opts.mode === 'migrate') {
    // keyset 分頁：游標只會前進，所以失敗的那幾筆不會在同一趟裡被無限重抓。
    // 跨趟續跑則靠 LEFT JOIN 帳本自然跳過已完成的。
    let cursor = '';
    const total = (await pool.query('SELECT count(*)::int AS n FROM uploaded_files')).rows[0].n;
    const doneAlready = hasLedger
      ? (await pool.query(`SELECT count(*)::int AS n FROM ${LEDGER_TABLE}`)).rows[0].n : 0;
    console.log(`uploaded_files 共 ${total} 筆，帳本已完成 ${doneAlready} 筆，本趟待處理 ${total - doneAlready} 筆`
      + (opts.limit ? `（--limit=${opts.limit}）` : '') + '\n');

    for (;;) {
      if (opts.limit && processed >= opts.limit) break;
      const take = opts.limit ? Math.min(opts.batch, opts.limit - processed) : opts.batch;
      const sql = hasLedger
        ? `SELECT u.key, u.bytes, u.byte_size FROM uploaded_files u
             LEFT JOIN ${LEDGER_TABLE} m ON m.key = u.key
            WHERE u.key > $1 AND m.key IS NULL ORDER BY u.key LIMIT $2`
        : `SELECT u.key, u.bytes, u.byte_size FROM uploaded_files u
            WHERE u.key > $1 ORDER BY u.key LIMIT $2`;
      const batch = (await pool.query(sql, [cursor, take])).rows;
      if (!batch.length) break;
      cursor = batch[batch.length - 1].key;

      for (const row of batch) {
        processed += 1;
        try {
          const r = await migrateOne({ row, bucket, pool, apply: opts.willWrite });
          out.ok += 1;
          out.bytes += r.bytes;
          console.log(`  [${processed}${opts.limit ? '/' + opts.limit : '/' + (total - doneAlready)}] `
            + `${r.status === 'dry-run' ? '(dry-run) ' : ''}${r.key}  ${r.bytes}B  md5=${r.md5.slice(0, 8)}`);
        } catch (e) {
          note(row.key, e);
        }
        await sleep(opts.gap);
      }
      console.log(`  ── 批次結束：累計 ${out.ok} 成功 / ${out.failed} 失敗 / ${mb(out.bytes)}`);
    }
  } else {
    if (!hasLedger) {
      console.log('帳本不存在，沒有可處理的紀錄。先跑一次搬移階段。');
      await pool.end();
      process.exit(0);
      return;
    }
    const where = opts.mode === 'delete' ? 'WHERE db_deleted_at IS NULL' : '';
    const rows = (await pool.query(
      `SELECT key, byte_size, md5 FROM ${LEDGER_TABLE} ${where} ORDER BY key`
      + (opts.limit ? ` LIMIT ${Number(opts.limit)}` : ''),
    )).rows;
    console.log(`帳本待處理 ${rows.length} 筆\n`);

    for (const ledgerRow of rows) {
      processed += 1;
      try {
        const r = opts.mode === 'delete'
          ? await deleteDbCopyOne({ ledgerRow, bucket, pool, apply: opts.willDeleteDbRows })
          : await verifyOne({ ledgerRow, bucket });
        if (r.status === 'already-deleted') out.skipped += 1; else out.ok += 1;
        out.bytes += r.bytes;
        console.log(`  [${processed}/${rows.length}] ${r.status}  ${r.key}  ${r.bytes}B`);
      } catch (e) {
        note(ledgerRow.key, e);
      }
      await sleep(opts.gap);
    }
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`\n完成：成功 ${out.ok} / 略過 ${out.skipped} / 失敗 ${out.failed}，`
    + `處理 ${mb(out.bytes)}，耗時 ${secs}s`);
  if (out.errors.length) {
    console.log('失敗清單（前 20 筆，其餘同因請重跑本指令，已成功的不會重做）：');
    out.errors.slice(0, 20).forEach((e) => console.log('  ' + e));
  }
  if (!opts.willWrite && opts.mode === 'migrate') {
    console.log('\n這是 dry-run。加上 --apply 才會真的搬。建議先 --apply --limit=20 跑一輪。');
  }
  if (opts.mode === 'migrate' && opts.willWrite && out.failed === 0) {
    console.log('\n下一步：--verify-only 重驗一次，隔幾天確認正式站讀得到 bucket 上的檔案，');
    console.log('再考慮 --delete-db-copy（刪除是獨立旗標，不會被 --apply 順便觸發）。');
  }

  await pool.end();
  process.exit(out.failed ? 1 : 0);
}

module.exports = {
  LEDGER_TABLE,
  LEDGER_DDL,
  md5,
  parseArgs,
  migrateOne,
  verifyOne,
  deleteDbCopyOne,
  unwrapDownload,
};

if (require.main === module) {
  main().catch((e) => { console.error('中止：' + (e && e.message)); process.exit(1); });
}

// ── 前置作業：在 Replit 介面開通 Object Storage ──
// 這一步沒有程式可以代勞（Replit 沒有開放以 API 建 bucket）。實測 sidecar
// http://127.0.0.1:1106/object-storage/default-bucket 回 {"bucketId":""}，
// 也就是這個 Repl 名下一個 bucket 都沒有。開通方式：
//   1. 打開這個 Repl → 左側工具列最下方 "＋"（All tools / Tools）
//   2. 搜尋並點選 "Object Storage"
//   3. 面板中按 "Create a bucket"（首次會顯示 "Get started"），採用預設名稱即可
//   4. 建好後回來重跑 `node scripts/uploadedFilesToBucket.js`，
//      preflight 應該顯示 OK
// 開通後**不需要改任何程式**：NODE_ENV=production 且未設 OBJECT_STORAGE_DRIVER 時，
// objectStorage.js 會自動選 replit driver，server/index.js 啟動時的
// assertProductionStorageReady 會通過，新上傳自動進 bucket。舊檔案則由
// openUpload 的 read-through 繼續從 uploaded_files 供應，直到這支搬完為止。
