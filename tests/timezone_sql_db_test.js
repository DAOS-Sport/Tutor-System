'use strict';
/**
 * Issue #11：業務日期 SQL 對真的 Postgres 求值，連線 TimeZone 換成 UTC／洛杉磯也要得到台北的答案。
 *
 * 只對常數運算式求值：不建表、不寫任何資料、不讀任何資料表。
 * 「現在」一律用參數模擬（把片段裡的 NOW() 換成 $n::timestamptz），才能穩定落在台北
 * 00:00–08:00 這段最容易出錯的窗口（UTC 還是前一天）。
 *
 * 每個案例都同時跑「舊寫法」做對照：舊寫法在 UTC 下必須是錯的 —— 否則這個案例
 * 根本沒踩到邊界，綠燈不代表什麼。
 */
const path = require('path');
const { Pool } = require(path.join(__dirname, '..', 'server', 'node_modules', 'pg'));
const sql = require(path.join(__dirname, '..', 'server/utils/sessionDateSql'));
// 載入 models/db 只為了它註冊的 DATE/TIMESTAMP 解析器；它自己的 Pool 不會被使用、也不會連線。
require(path.join(__dirname, '..', 'server/models/db'));

const conn = process.env.TEST_DATABASE_URL;
if (!conn) {
  console.error('timezone_sql_db_test: 需要 TEST_DATABASE_URL（不沿用 DATABASE_URL）');
  process.exit(1);
}
const pool = new Pool({ connectionString: conn });

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  ok   ' + label); return; }
  failures += 1;
  console.error('  FAIL ' + label + (detail ? '\n       ' + detail : ''));
}

async function evalIn(tz, expr, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL TimeZone = '${tz}'`);
    const r = await client.query(`SELECT (${expr}) AS v`, params);
    await client.query('ROLLBACK');
    return r.rows[0].v;
  } finally {
    client.release();
  }
}

// 台北 2026-11-01 00:30（UTC 仍是 10/31 16:30）
const AT = '2026-10-31T16:30:00Z';
const ZONES = ['Asia/Taipei', 'UTC', 'America/Los_Angeles'];

(async () => {
  // 1) 報表區間（reports.js）：台北 11/01 00:30 建立的課期，查 11/01～11/01 必須算進去。
  const reportsNew = `${sql.taipeiDate('$1::timestamptz')} BETWEEN $2::date AND $3::date`;
  const reportsOld = `$1::timestamptz::date BETWEEN $2::date AND $3::date`;
  for (const tz of ZONES) {
    check(`reports 區間 TZ=${tz}`, await evalIn(tz, reportsNew, [AT, '2026-11-01', '2026-11-01']) === true);
  }
  check('reports 舊寫法在 UTC 下確實會漏單（案例有踩到邊界）',
    await evalIn('UTC', reportsOld, [AT, '2026-11-01', '2026-11-01']) === false);

  // 2) 報表的「已過期」：expires_at（DATE）< 台北今天。現在＝台北 11/01 00:30，10/31 到期的已過期。
  const expiredNew = `$2::date < ${sql.taipeiToday().replace(/NOW\(\)/g, '$1::timestamptz')}`;
  const expiredOld = `$2::date < $1::timestamptz::date`; // CURRENT_DATE 的等價
  for (const tz of ZONES) {
    check(`reports 已過期 TZ=${tz}`, await evalIn(tz, expiredNew, [AT, '2026-10-31']) === true);
  }
  check('CURRENT_DATE 舊寫法在 UTC 下確實判錯', await evalIn('UTC', expiredOld, [AT, '2026-10-31']) === false);

  // 3) MGM 統計（mgmStats.js）：from=to=11/01，台北 11/01 00:30 的推薦要算、10/31 23:59 的不算。
  const mgmNew = `$1::timestamptz >= ${sql.taipeiDayStart('$2')} AND $1::timestamptz < ${sql.taipeiDayStart('$3::date + 1')}`;
  const mgmOld = `$1::timestamptz >= $2::date AND $1::timestamptz < ($3::date + INTERVAL '1 day')`;
  for (const tz of ZONES) {
    check(`mgm 起訖 TZ=${tz}：邊界內`, await evalIn(tz, mgmNew, [AT, '2026-11-01', '2026-11-01']) === true);
    check(`mgm 起訖 TZ=${tz}：前一晚不算`,
      await evalIn(tz, mgmNew, ['2026-10-31T15:59:00Z', '2026-11-01', '2026-11-01']) === false);
  }
  check('mgm 舊寫法在 UTC 下確實會漏', await evalIn('UTC', mgmOld, [AT, '2026-11-01', '2026-11-01']) === false);

  // 4) 評鑑月份（evaluations.js）
  const monthNew = `TO_CHAR(DATE_TRUNC('month', $1::timestamptz AT TIME ZONE 'Asia/Taipei'), 'YYYY-MM')`;
  const monthOld = `TO_CHAR(DATE_TRUNC('month', $1::timestamptz), 'YYYY-MM')`;
  for (const tz of ZONES) {
    check(`評鑑月份 TZ=${tz}`, await evalIn(tz, monthNew, [AT]) === '2026-11');
  }
  check('評鑑月份舊寫法在 UTC 下確實算成上個月', await evalIn('UTC', monthOld, [AT]) === '2026-10');

  // 5) 課程需求的「今天」（courseTypes.js）
  const todayNew = `((($1::timestamptz) AT TIME ZONE 'Asia/Taipei')::date)::text`;
  for (const tz of ZONES) {
    check(`課程需求今天 TZ=${tz}`, await evalIn(tz, todayNew, [AT]) === '2026-11-01');
  }

  // 6) 課期效期的建議寫法（enrollments.js 未改，見稽核文件）：台北日期 + N 天。
  const expiryNew = `((($1::timestamptz) AT TIME ZONE 'Asia/Taipei') + ($2 || ' days')::interval)::date::text`;
  for (const tz of ZONES) {
    check(`效期 +30 天 TZ=${tz}`, await evalIn(tz, expiryNew, [AT, '30']) === '2026-12-01');
  }

  // 7) pg 回傳值解析（models/db.js 註冊）：DATE 與 AT TIME ZONE 產生的 timestamp，
  //    不論連線 TimeZone 或 Node TZ，都要還原成同一個絕對時刻。
  for (const tz of ZONES) {
    const d = await evalIn(tz, `'2026-11-01'::date`, []);
    check(`DATE 解析 TZ=${tz}`, d instanceof Date && d.toISOString() === '2026-10-31T16:00:00.000Z', String(d && d.toISOString()));
    const ts = await evalIn(tz, `$1::timestamptz AT TIME ZONE 'Asia/Taipei'`, [AT]);
    check(`台北 timestamp 解析 TZ=${tz}`, ts instanceof Date && ts.toISOString() === '2026-10-31T16:30:00.000Z', String(ts && ts.toISOString()));
  }

  await pool.end();
  if (failures) {
    console.error(`timezone_sql_db_test: ${failures} FAIL`);
    process.exitCode = 1;
  } else {
    console.log('timezone_sql_db_test: PASS');
  }
})().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});

