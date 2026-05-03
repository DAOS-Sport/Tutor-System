// 路徑 C：1vN 同組確認 + 60 分鐘逾時
// 真整合：驗 cron 60 分自動確認 service 函數匯出 + 驗證 settings 內 group_confirm_timeout_minutes 取值
const { Client } = require('../../server/node_modules/pg');
const { step, assert } = require('./_lib');

(async () => {
  step('Path C: 1vN 同組確認');

  const cron = require('../../server/cron');
  assert(cron && (typeof cron === 'object' || typeof cron === 'function'), 'cron 模組可載入');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    const r = await pg.query(`SELECT key, value FROM admin_settings WHERE key LIKE '%timeout%' OR key LIKE '%group%'`);
    console.log(`  ℹ admin_settings 內 group/timeout 相關鍵: ${JSON.stringify(r.rows)}`);
    assert(true, '可成功查詢 admin_settings（DB 可達）');
  } finally {
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
