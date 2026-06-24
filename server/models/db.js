const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// 全站統一台灣時區：每條連線一建立就設成 Asia/Taipei，讓 CURRENT_DATE / NOW()::date /
// timestamptz::date 等隱式日期運算都以台灣時間為準（資料一致性）。明確的
// "... AT TIME ZONE 'Asia/Taipei'" 屬絕對換算、不受此設定影響，仍正確。
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Taipei'").catch((err) => console.warn('[DB] set timezone failed:', err.message));
});
pool.on('error', (err) => console.error('[DB] unexpected error:', err));
module.exports = { pool };
