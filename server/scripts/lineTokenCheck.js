// 唯讀診斷：只回報「拿不拿得到 token」，絕不印出 token 內容，不打 LINE、不發訊息。
const line = require('../services/line');
const { pool } = require('../models/db');
(async () => {
  const v = await pool.query(`SELECT id, name FROM venues WHERE is_active IS NOT FALSE ORDER BY id`);
  console.log('=== 各場館能否取得 Messaging API token ===');
  let ok = 0, bad = 0;
  for (const r of v.rows) {
    try {
      const t = line._getTokenForDiagnostics(r.id);
      console.log('  ' + r.id.padEnd(3) + String(r.name).padEnd(12) + '拿得到 ✓  (長度 ' + t.length + ')');
      ok += 1;
    } catch (e) {
      console.log('  ' + r.id.padEnd(3) + String(r.name).padEnd(12) + '** ' + e.message + ' **');
      bad += 1;
    }
  }
  console.log('\n  可用 ' + ok + ' / 缺 ' + bad);
  const envNames = Object.keys(process.env).filter((k) => k.startsWith('LINE_MESSAGING_TOKEN')).sort();
  console.log('\n=== 目前設定的變數（只列名稱）===');
  envNames.forEach((k) => console.log('  ' + k));
  await pool.end(); process.exit(0);
})().catch((e) => { console.log('失敗：' + e.message); process.exit(1); });