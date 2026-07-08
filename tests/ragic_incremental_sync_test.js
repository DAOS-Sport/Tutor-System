// Phase 5（docs/ragic_sync_audit.md）：增量同步（field 109 watermark）驗證。
// 1. formatRagicDateTime：純函式，驗證 yyyy/MM/dd HH:mm:ss 格式與台灣時區位移。
// 2. 增量查詢真的會帶上 where=109,gte,<watermark>&order=109,ASC（monkeypatch axios 攔截，
//    比照 tests/perf/ragic_concurrency.js 的手法，檢查實際送出的 params）。
// 3. getSyncWatermark/setSyncWatermark：對 admin_settings 的輕量 round-trip（跟既有
//    isJobEnabled/setJobEnabled 同一張表、同一種輕量 key-value 讀寫，非全表同步，
//    代價與既有 job-toggle 測試相當，可安全對真實 DB 跑）。
const assert = require('assert');
const Module = require('module');
const { pool } = require('../server/models/db');

process.env.RAGIC_BASE_URL = process.env.RAGIC_BASE_URL || 'http://stub';
process.env.RAGIC_API_KEY = process.env.RAGIC_API_KEY || 'stub';
process.env.RAGIC_FORM_H01 = process.env.RAGIC_FORM_H01 || '/h01';
process.env.RAGIC_FORM_Z01 = process.env.RAGIC_FORM_Z01 || '/z01';

let lastParams = null;
const origLoad = Module._load;
Module._load = function (req, parent) {
  if (req === 'axios' && parent && parent.id && parent.id.endsWith('services/ragic.js')) {
    return {
      create: () => ({
        get: async (url, opts) => {
          lastParams = opts?.params || null;
          return { data: {} }; // 空物件 → queryAllPaged 視為自然結尾，不會無限分頁
        },
      }),
    };
  }
  return origLoad.apply(this, arguments);
};
delete require.cache[require.resolve('../server/services/ragic')];
const ragic = require('../server/services/ragic');
const ragicAdmin = require('../server/services/ragicAdmin');

function testFormatRagicDateTime() {
  // 2026-07-08T03:00:00.000Z (UTC) + 8h（台灣，無 DST）= 2026-07-08 11:00:00
  assert.strictEqual(ragic.formatRagicDateTime(new Date('2026-07-08T03:00:00.000Z')), '2026/07/08 11:00:00');
  // 跨日邊界：UTC 16:30 + 8h = 隔天 00:30
  assert.strictEqual(ragic.formatRagicDateTime(new Date('2026-07-08T16:30:00.000Z')), '2026/07/09 00:30:00');
}

async function testIncrementalFetchSendsWhereAndOrder() {
  lastParams = null;
  const watermark = new Date('2026-07-07T00:00:00.000Z');
  await ragic.getAllStaffChangedSinceWithFreshness(watermark).catch(() => {});
  assert.ok(lastParams, 'expected the stubbed axios.get to have been called');
  assert.strictEqual(lastParams.where, `109,gte,${ragic.formatRagicDateTime(watermark)}`);
  assert.strictEqual(lastParams.order, '109,ASC');
}

async function testWatermarkRoundTrip() {
  const formCode = 'ZZTEST_WATERMARK_FORM';
  // 前置＋後置都清理（try/finally），避免上次執行殘留的值讓「初次應為 null」誤判失敗，
  // 也避免這次留下殘留值影響下一次執行。
  await pool.query(`DELETE FROM admin_settings WHERE key = $1`, [`ragic_watermark_${formCode}`]);
  try {
    const before = await ragicAdmin.getSyncWatermark(formCode);
    assert.strictEqual(before, null);

    const stamp = new Date('2026-07-08T01:23:45.000Z');
    await ragicAdmin.setSyncWatermark(formCode, stamp);
    const after = await ragicAdmin.getSyncWatermark(formCode);
    assert.ok(after instanceof Date);
    assert.strictEqual(after.getTime(), stamp.getTime());

    // 推進 watermark（覆寫既有值）
    const stamp2 = new Date('2026-07-08T05:00:00.000Z');
    await ragicAdmin.setSyncWatermark(formCode, stamp2);
    const after2 = await ragicAdmin.getSyncWatermark(formCode);
    assert.strictEqual(after2.getTime(), stamp2.getTime());
  } finally {
    await pool.query(`DELETE FROM admin_settings WHERE key = $1`, [`ragic_watermark_${formCode}`]);
  }
}

(async () => {
  testFormatRagicDateTime();
  await testIncrementalFetchSendsWhereAndOrder();
  await testWatermarkRoundTrip();
  console.log('ragic_incremental_sync_test: PASS');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
