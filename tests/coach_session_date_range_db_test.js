'use strict';
/**
 * 教練端日期範圍條件 —— 對真的 Postgres 求值（語意鎖）。
 *
 * 只對常數運算式求值：不建表、不寫任何資料、不讀任何資料表。
 * 但仍歸在 DB 層，因為它需要一條真實連線 —— 這裡要驗的正是「Postgres 怎麼解讀
 * 這串 SQL」，用 JS 重寫一份來驗等於什麼都沒驗。
 *
 * 關鍵設計：每個案例都跑兩次，一次 TimeZone=Asia/Taipei、一次 UTC。
 * 結果必須完全相同 —— 條件若依賴連線設定，換個環境就整批偏 8 小時。
 */
const assert = require('assert');
const path = require('path');
// pg 裝在 server/node_modules，測試檔的解析基準是自己的位置，要顯式指路（與 tests/release/ 的既有寫法一致）
const { Pool } = require(path.join(__dirname, '..', 'server', 'node_modules', 'pg'));
const sql = require(path.join(__dirname, '..', 'server/utils/sessionDateSql'));

const conn = process.env.TEST_DATABASE_URL;
if (!conn) {
  console.error('coach_session_date_range_db_test: 需要 TEST_DATABASE_URL（不沿用 DATABASE_URL）');
  process.exit(1);
}
const pool = new Pool({ connectionString: conn });

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  ok   ' + label); return; }
  failures += 1;
  console.error('  FAIL ' + label + (detail ? '\n       ' + detail : ''));
}

// $1=課程時間 $2=from $3=to $4=模擬的「現在」
const HISTORY = sql.historyRangeWhere('$1::timestamptz', '$2', '$3').replace(/NOW\(\)/g, '$4::timestamptz');
const WEEK = sql.weekRangeWhere('$1::timestamptz', '$2', '$3');

async function evalIn(tz, expr, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL TimeZone = '${tz}'`);
    const r = await client.query(`SELECT (${expr}) AS ok`, params);
    return r.rows[0].ok;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** 同一個案例在兩種 TimeZone 下都要得到 expected。 */
async function bothZones(label, expr, params, expected) {
  const tpe = await evalIn('Asia/Taipei', expr, params);
  const utc = await evalIn('UTC', expr, params);
  check(label + '（TimeZone=Asia/Taipei）', tpe === expected, '預期 ' + expected + '，實際 ' + tpe);
  check(label + '（TimeZone=UTC）', utc === expected,
    '預期 ' + expected + '，實際 ' + utc + ' —— 條件依賴連線 TimeZone，換環境就會整批偏 8 小時');
}

(async () => {
  console.log('coach_session_date_range_db_test');
  const NOW = '2026-08-07 21:00:00+08';   // 台北當天晚上，教練下課後去看記錄

  // ── 授課記錄 ──
  await bothZones('★ 今天上午的課，to=今天 → 必須列入（教練回報的問題）',
    HISTORY, ['2026-08-07 11:51:00+08', '2026-07-08', '2026-08-07', NOW], true);

  await bothZones('今天深夜 23:30 的課仍算今天',
    HISTORY, ['2026-08-07 23:30:00+08', '2026-07-08', '2026-08-07', NOW], true);

  await bothZones('昨天的課 → 列入',
    HISTORY, ['2026-08-06 11:52:00+08', '2026-07-08', '2026-08-07', NOW], true);

  await bothZones('明天的課 → 不列入（未來是排課頁的事）',
    HISTORY, ['2026-08-08 09:00:00+08', '2026-07-08', '2026-08-31', NOW], false);

  await bothZones('早於 from → 不列入',
    HISTORY, ['2026-07-07 09:00:00+08', '2026-07-08', '2026-08-07', NOW], false);

  await bothZones('晚於 to → 不列入',
    HISTORY, ['2026-08-07 09:00:00+08', '2026-07-08', '2026-08-05', NOW], false);

  await bothZones('台北日界線：UTC 16:00 = 台北隔日 00:00，算隔日',
    HISTORY, ['2026-08-06 16:00:00+00', '2026-08-07', '2026-08-07', NOW], true);

  await bothZones('from/to 皆為 NULL → 只受「不得晚於今天」限制',
    HISTORY, ['2026-08-07 11:51:00+08', null, null, NOW], true);

  // ── 週課表 ──
  await bothZones('週課表：台北 08:30 的課，from=當天 → 必須列入',
    WEEK, ['2026-08-07 08:30:00+08', '2026-08-07', '2026-08-14'], true);

  await bothZones('週課表：台北 00:05 的課，from=當天 → 必須列入',
    WEEK, ['2026-08-07 00:05:00+08', '2026-08-07', '2026-08-14'], true);

  await bothZones('週課表：區間結束日當天不列入（半開區間 [from, to)）',
    WEEK, ['2026-08-14 09:00:00+08', '2026-08-07', '2026-08-14'], false);

  await bothZones('週課表：前一天不列入',
    WEEK, ['2026-08-06 23:59:00+08', '2026-08-07', '2026-08-14'], false);

  await pool.end();
  if (failures) {
    console.error('\ncoach_session_date_range_db_test: ' + failures + ' failed');
    process.exit(1);
  }
  console.log('coach_session_date_range_db_test: all passed');
})().catch(async (e) => {
  console.error('未預期例外：' + e.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
