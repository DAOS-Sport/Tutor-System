#!/usr/bin/env node
/**
 * Ragic 分頁同步煙霧測試（docs/ragic_sync_audit.md Phase 6）
 *
 * 用途：不猜測、直接對真實 Ragic 帳號打有限頁數的分頁查詢，驗證：
 *   - endpoint（遮罩過，不洩漏 API key／帳號路徑全貌）
 *   - 實際跑了幾頁、每頁筆數、每頁耗時
 *   - 總筆數、第一筆／最後一筆 record id
 *   - schema 缺漏欄位（比對 config/ragicSchema.js 已知 Field ID 是否出現在回傳資料中）
 *   - 錯誤分類（RAGIC_TIMEOUT / RAGIC_AUTH_FAILED / RAGIC_HTTP_SERVER_ERROR / ... ）
 *
 * 用法（於 server/ 目錄下）：
 *   npm run ragic:smoke -- --form H01_STAFF --limit 20 --pages 1
 *   npm run ragic:smoke -- --form H01_STAFF --limit 100 --max-pages 10
 *
 * 參數：
 *   --form <H01_STAFF|H05_VENUES|Z01_PARENTS|Z02_STUDENTS>  必填
 *   --limit <n>       每頁筆數，預設 100
 *   --pages <n>       最多跑幾頁（--max-pages 為別名），預設 3
 *   --where <expr>    可選，額外 where 條件字串（例如 "109,gte,2026/07/01 00:00:00"）
 *   --order <expr>    可選，例如 "109,ASC"
 *   --listing         flag：加上 listing=true
 *   --subtables <0|1> 可選
 *   --naming <EID>    可選（用來手動驗證 naming=EID 在這個帳號上的實際行為）
 *
 * 只讀：本腳本完全不寫入 Ragic，安全可重複執行。
 * 退出碼：0=成功跑完（可能仍有 schema 缺漏警告，但不算失敗）、1=打 Ragic 發生錯誤或參數錯誤。
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

function parseArgs(argv) {
  const out = { limit: 100, pages: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'listing') { out.listing = true; continue; }
    if (next == null || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  if (out['max-pages'] != null) out.pages = out['max-pages'];
  return out;
}

// 帳號路徑本身不是使用者 PII，但仍遮蔽中段避免完整帳號名稱外洩到 log/CI 輸出。
function maskEndpoint(formPath) {
  try {
    const u = new URL(formPath.split('?')[0]);
    const segments = u.pathname.split('/').filter(Boolean);
    const masked = segments.map((seg, i) => {
      if (i === segments.length - 1) return seg; // 最後一段通常是表單代號（1/2/23...），非帳號機密
      if (seg.length <= 2) return seg;
      return `${seg.slice(0, 1)}${'*'.repeat(seg.length - 2)}${seg.slice(-1)}`;
    });
    return `${u.protocol}//${u.host}/${masked.join('/')}`;
  } catch (_) {
    return '(unparseable endpoint — masked entirely)';
  }
}

const FORM_CONFIGS = {
  H01_STAFF:    { env: 'RAGIC_FORM_H01' },
  H05_VENUES:   { env: 'RAGIC_FORM_H05' },
  Z01_PARENTS:  { env: 'RAGIC_FORM_Z01' },
  Z02_STUDENTS: { env: 'RAGIC_FORM_Z02' },
};

function knownFieldIdsFor(formCode, ragicSchema) {
  const { H01, Z01_FIELDS, Z02_FIELDS } = ragicSchema;
  if (formCode === 'H01_STAFF') return [H01.DATA_NO, H01.LINE_UID, '3000933', '3000945'];
  if (formCode === 'Z01_PARENTS') return Object.values(Z01_FIELDS);
  if (formCode === 'Z02_STUDENTS') return Object.values(Z02_FIELDS);
  return [];
}

function checkSchemaMissingFields(rows, knownFieldIds) {
  if (!rows.length || !knownFieldIds.length) return [];
  const sampleKeys = new Set(Object.keys(rows[0] || {}));
  return knownFieldIds.filter((fid) => !sampleKeys.has(String(fid)));
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  console.log('=== Ragic 分頁同步煙霧測試 ===');

  if (!args.form || !FORM_CONFIGS[args.form]) {
    console.error(`[FAIL] --form 必填，可用值：${Object.keys(FORM_CONFIGS).join(' | ')}`);
    process.exit(1);
  }
  const config = FORM_CONFIGS[args.form];
  const formPath = process.env[config.env];
  if (!formPath) {
    console.error(`[FAIL] 環境變數 ${config.env} 未設定，無法定位 ${args.form} 表單`);
    process.exit(1);
  }
  if (!process.env.RAGIC_API_KEY || !process.env.RAGIC_BASE_URL) {
    console.error('[FAIL] RAGIC_API_KEY / RAGIC_BASE_URL 未設定');
    process.exit(1);
  }

  const ragic = require('../services/ragic');
  const ragicSchema = require('../config/ragicSchema');
  const limit = Number(args.limit) || 100;
  const maxPages = Number(args.pages) || 3;

  console.log(`endpoint (masked): ${maskEndpoint(formPath)}`);
  console.log(`form: ${args.form}  limit: ${limit}  max_pages: ${maxPages}`);
  if (args.where) console.log(`where: ${args.where}`);
  if (args.listing) console.log('listing: true');
  if (args.subtables != null) console.log(`subtables: ${args.subtables}`);
  if (args.naming) console.log(`naming: ${args.naming}`);
  console.log('');

  let totalRows = 0;
  let firstRecordId = null;
  let lastRecordId = null;
  const pageStats = [];
  let pagesRun = 0;
  let stopReason = 'max_pages_reached';

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    const pageStarted = Date.now();
    let result;
    try {
      result = await ragic.fetchPage(formPath, {
        limit, offset, where: args.where, order: args.order,
        listing: args.listing ? 'true' : undefined,
        subtables: args.subtables, naming: args.naming,
      });
    } catch (err) {
      const durationMs = Date.now() - pageStarted;
      console.error(`[FAIL] form=${args.form} offset=${offset} limit=${limit} duration_ms=${durationMs}: ${err.code || '(unclassified)'} — ${err.message}`);
      if (err.retryCount != null) console.error(`  retry_count=${err.retryCount}`);
      console.log('');
      console.log('=== error classification ===');
      console.log(`form_code: ${args.form}`);
      console.log(`offset: ${offset}`);
      console.log(`limit: ${limit}`);
      console.log(`duration_ms: ${durationMs}`);
      console.log(`code: ${err.code || '(unclassified)'}`);
      console.log(`retry_count: ${err.retryCount ?? 0}`);
      process.exit(1);
    }
    pagesRun++;
    pageStats.push({ page, offset, count: result.count, duration_ms: result.durationMs });
    console.log(`page=${page} offset=${offset} count=${result.count} duration_ms=${result.durationMs}`);
    totalRows += result.count;
    if (result.count > 0) {
      const ids = result.rows.map((r) => (r && r._ragicId != null ? String(r._ragicId) : null)).filter(Boolean);
      if (ids.length) {
        if (firstRecordId == null) firstRecordId = ids[0];
        lastRecordId = ids[ids.length - 1];
      }
    }
    if (result.count < limit) { stopReason = 'natural_end'; break; }
  }

  console.log('');
  console.log('=== 摘要 ===');
  console.log(`pages_run: ${pagesRun} (${stopReason})`);
  console.log(`total_rows: ${totalRows}`);
  console.log(`first_record_id: ${firstRecordId ?? '(none)'}`);
  console.log(`last_record_id: ${lastRecordId ?? '(none)'}`);
  console.log(`duration_per_page_ms: ${pageStats.map((p) => p.duration_ms).join(', ')}`);

  // schema 缺漏欄位檢查：對第一頁重新查一次（limit 用原本值即可，讀取成本與上面第 0 頁相同量級）
  // 是刻意的獨立、透明的一步，而非隱藏在分頁迴圈裡，方便閱讀輸出時對照。
  try {
    const sample = await ragic.fetchPage(formPath, { limit: Math.max(1, Math.min(limit, 5)), offset: 0 });
    const knownFieldIds = knownFieldIdsFor(args.form, ragicSchema);
    const missing = checkSchemaMissingFields(sample.rows, knownFieldIds);
    console.log(`schema_missing_fields: ${missing.length ? missing.join(', ') : '(none)'}`);
  } catch (err) {
    console.log(`schema_missing_fields: (check failed — ${err.code || 'unclassified'}: ${err.message})`);
  }

  console.log('');
  console.log('=== error classification ===');
  console.log('code: (none — all pages succeeded)');

  process.exit(0);
})().catch((err) => {
  console.error('[FAIL] smoke crashed:', err.code || '(unclassified)', err.message);
  process.exit(1);
});
