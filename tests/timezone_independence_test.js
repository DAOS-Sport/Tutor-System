'use strict';
/**
 * Issue #11：日期／時間邏輯不得依賴執行環境的時區。
 *
 * 正式機 TZ=Asia/Taipei（server/index.js 也會強制設定），但那只是保險，不是語意。
 * 這支把同一組「台北跨日邊界」案例丟進不同 TZ 的子行程各跑一次：
 *   Asia/Taipei、UTC、America/Los_Angeles（UTC-7/-8，有日光節約）、
 *   Asia/Tokyo（UTC+9：比台北東，pg 預設 DATE 解析在這裡會退回前一天）、
 *   Pacific/Kiritimati（UTC+14，最極端）。
 * 每個 TZ 的輸出都必須等於預期值 —— 也就等於彼此相同。
 *
 * 不連 DB、不出網路：pg 只載入型別解析器，Pool 不會連線。
 * 涵蓋：server/utils/dateTime.js、models/db.js 註冊的 DATE/TIMESTAMP 解析器、
 * studentAudit 的生日比對、cron/slots 的台北時段、sessionDateSql 的 SQL 片段、
 * client/admin 與 client/liff 的 utils/format.js。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');

// 台北跨日邊界的絕對時刻：台北 2026-11-01 00:30 ＝ UTC 2026-10-31 16:30。
// 選月初是為了同時測「月份」：UTC 仍是 10 月，台北已是 11 月。
const BOUNDARY = '2026-10-31T16:30:00.000Z';
const BEFORE = '2026-10-31T15:59:59.000Z'; // 台北 10/31 23:59:59
const EARLY_MORNING = '2026-11-01T23:59:00.000Z'; // 台北 11/02 07:59（UTC 仍是 11/01）

async function probe() {
  // models/db.js 需要 DATABASE_URL 才會有連線字串，但這裡只要它的副作用（註冊型別解析器），
  // 不發任何查詢，所以給一個不可能連得上的假位址，確保不會意外打到任何資料庫。
  process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/never';
  const dt = require(path.join(SERVER, 'utils/dateTime'));
  require(path.join(SERVER, 'models/db'));
  const { types } = require(path.join(SERVER, 'node_modules', 'pg'));
  const audit = require(path.join(SERVER, 'services/studentAudit'));
  const sql = require(path.join(SERVER, 'utils/sessionDateSql'));
  const slots = require(path.join(SERVER, 'cron/slots'));
  const admin = await import(path.join(ROOT, 'client/admin/src/utils/format.js'));
  const liff = await import(path.join(ROOT, 'client/liff/src/utils/format.js'));

  const pgDate = types.getTypeParser(1082, 'text');
  const pgTs = types.getTypeParser(1114, 'text');
  const birth = pgDate('2010-01-02');

  return {
    taipeiToday_boundary: dt.taipeiToday(new Date(BOUNDARY)),
    taipeiToday_before: dt.taipeiToday(new Date(BEFORE)),
    taipeiToday_early: dt.taipeiToday(new Date(EARLY_MORNING)),
    taipeiMonthKey_boundary: dt.taipeiMonthKey(new Date(BOUNDARY)),
    formatPlainDate_str: dt.formatPlainDate('2026-11-01'),
    formatTaipeiDateTime: dt.formatTaipeiDateTime(new Date(BOUNDARY)),
    formatTaipeiTime: dt.formatTaipeiTime(new Date(BOUNDARY)),
    addCalendarDays: dt.addCalendarDays('2026-10-31', 1),
    taipeiWeekStart: dt.taipeiWeekStart(new Date(BOUNDARY)),
    pg_date_iso: pgDate('2026-11-01').toISOString(),
    pg_date_plain: dt.formatPlainDate(pgDate('2026-11-01')),
    pg_date_json: JSON.stringify({ d: pgDate('2026-11-01') }),
    pg_date_infinity: String(pgDate('infinity')),
    pg_ts_iso: pgTs('2026-11-01 00:30:00.123456').toISOString(),
    audit_birth_unchanged: audit.diffChanges({ birth_date: birth }, { birth_date: '2010-01-02' }, ['birth_date']),
    audit_birth_value: audit.diffChanges({ birth_date: birth }, { birth_date: '2010-01-03' }, ['birth_date']),
    slot_due: slots.latestDueSlot ? slots.latestDueSlot('09:00', new Date(BOUNDARY)) : null,
    sql_day_start: sql.taipeiDayStart('$1'),
    admin_plain_ts: admin.formatPlainDate(BOUNDARY),
    admin_plain_str: admin.formatPlainDate('2026-11-01'),
    admin_datetime: admin.formatTWDateTime(BOUNDARY),
    admin_hm: admin.formatHM(BOUNDARY),
    liff_ymd: liff.formatTWYMD(BOUNDARY),
    liff_plain_ts: liff.formatPlainDate(BOUNDARY),
    liff_plain_str: liff.formatPlainDate('2026-11-01'),
    liff_month: liff.formatTWMonthKey(BOUNDARY),
    liff_add_days: liff.addDaysToTaipeiYMD('2026-10-31', 1),
    liff_calendar: liff.taipeiCalendarDate(BOUNDARY).toISOString(),
    liff_time: liff.formatTWTime(BOUNDARY),
  };
}

const EXPECTED = {
  taipeiToday_boundary: '2026-11-01',
  taipeiToday_before: '2026-10-31',
  taipeiToday_early: '2026-11-02',
  taipeiMonthKey_boundary: '2026-11',
  formatPlainDate_str: '2026-11-01',
  formatTaipeiDateTime: '2026/11/01 00:30',
  formatTaipeiTime: '00:30',
  addCalendarDays: '2026-11-01',
  taipeiWeekStart: '2026-11-01', // 2026-11-01 是星期日
  pg_date_iso: '2026-10-31T16:00:00.000Z', // 台北 11/01 00:00
  pg_date_plain: '2026-11-01',
  pg_date_json: '{"d":"2026-10-31T16:00:00.000Z"}', // 與正式機（TZ=Asia/Taipei）pg 預設輸出逐字相同
  pg_date_infinity: 'Infinity',
  pg_ts_iso: '2026-10-31T16:30:00.123Z',
  audit_birth_unchanged: null,
  audit_birth_value: { birth_date: { before: '2010-01-02', after: '2010-01-03' } },
  slot_due: { slotKey: '2026-10-31T09:00', date: '2026-10-31' }, // 台北 00:30 時，09:00 最近一次是前一天
  sql_day_start: "(($1)::date::timestamp AT TIME ZONE 'Asia/Taipei')",
  admin_plain_ts: '2026-11-01',
  admin_plain_str: '2026-11-01',
  admin_datetime: '2026/11/01（週日） 00:30',
  admin_hm: '00:30',
  liff_ymd: '2026-11-01',
  liff_plain_ts: '2026-11-01',
  liff_plain_str: '2026-11-01',
  liff_month: '2026-11',
  liff_add_days: '2026-11-01',
  liff_calendar: '2026-11-01T00:00:00.000Z',
  liff_time: '00:30',
};

if (process.env.TZ_PROBE === '1') {
  probe().then(
    (out) => { process.stdout.write(JSON.stringify(out)); },
    (err) => { console.error(err); process.exit(1); },
  );
  return;
}

const ZONES = ['Asia/Taipei', 'UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati'];
let failures = 0;
let first = null;
for (const tz of ZONES) {
  const r = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, TZ: tz, TZ_PROBE: '1' },
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.status !== 0) {
    failures += 1;
    console.error(`  FAIL TZ=${tz}：子行程失敗\n${r.stderr}`);
    continue;
  }
  const out = JSON.parse(r.stdout);
  for (const [key, want] of Object.entries(EXPECTED)) {
    try {
      assert.deepStrictEqual(out[key], want);
    } catch {
      failures += 1;
      console.error(`  FAIL TZ=${tz} ${key}: got ${JSON.stringify(out[key])}, want ${JSON.stringify(want)}`);
    }
  }
  if (first) {
    try { assert.deepStrictEqual(out, first); } catch {
      failures += 1;
      console.error(`  FAIL TZ=${tz} 輸出與 ${ZONES[0]} 不同`);
    }
  } else first = out;
  console.log(`  ok   TZ=${tz}（${Object.keys(EXPECTED).length} 項）`);
}

// ── 靜態守衛：已修正的業務日期查詢不得退回「吃連線 TimeZone」的寫法 ──────────
// 只鎖本次修過的檔案（其他檔案的現況見 docs/timezone_audit_2026-10.md）。
const GUARDED = [
  'server/routes/admin/reports.js',
  'server/routes/admin/mgmStats.js',
  'server/routes/admin/courseTypes.js',
  'server/services/evaluations.js',
];
const BAD = [
  [/CURRENT_DATE/, 'CURRENT_DATE（改用 (NOW() AT TIME ZONE \'Asia/Taipei\')::date）'],
  [/[a-z_]+\.[a-z_]+_at::date/, 'timestamptz::date（改用 sessionDateSql.taipeiDate）'],
  [/DATE_TRUNC\('month', submitted_at\)/i, 'DATE_TRUNC 未轉台北'],
  [/toISOString\(\)\.slice\(0, ?(7|10)\)/, 'toISOString().slice（UTC 日期）'],
  [/created_at >= \$\$\{args\.length\}::date/, 'timestamptz >= $n::date（吃連線 TimeZone）'],
];
for (const rel of GUARDED) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|--)/.test(l.trim()) && !/^\s*--/.test(l)).join('\n');
  for (const [re, why] of BAD) {
    if (re.test(src)) { failures += 1; console.error(`  FAIL ${rel} 出現 ${why}`); }
  }
}
console.log(`  ok   靜態守衛 ${GUARDED.length} 檔`);

if (failures) {
  console.error(`timezone_independence_test: ${failures} FAIL`);
  process.exitCode = 1;
} else {
  console.log('timezone_independence_test: PASS');
}
