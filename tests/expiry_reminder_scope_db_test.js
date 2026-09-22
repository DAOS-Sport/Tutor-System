'use strict';
// 到期提醒要挑哪些課期 —— 直接把 server/cron/index.js 裡那段 SQL 抽出來執行。
//
// 為什麼不自己抄一份 SQL：抄一份就變成在測我抄得對不對，程式改了測試還是綠的。
// 這支讀真正在跑的那段字串，所以有人把條件改掉就會紅。
//
// 守的契約（2026-09-22 Owner 指定 + 順手修掉的脆弱性）：
//   A. 只提醒「還有堂數沒上完」的課期（上完了就不該再催）。
//   B. 只提醒「還沒過期」且「N 天內到期」的（N = admin_settings.expiry_notice_days，預設 60）。
//   C. 觸發條件是區間不是等號 —— cron 漏跑一天不會讓那一期永遠收不到提醒。
//
// 獨立 schema、合成資料，不碰 LINE、不碰正式資料。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../server/node_modules/pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');

const schema = 'expiry_test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public -c statement_timeout=10000` });

/** 從 cron 原始碼抽出到期提醒那段 SQL（以 expiry_notice_days 當定位點）。 */
function extractExpirySql() {
  const src = fs.readFileSync(path.join(__dirname, '../server/cron/index.js'), 'utf8');
  const marker = src.indexOf("key='expiry_notice_days'");
  assert.ok(marker > 0, '找不到 expiry_notice_days —— cron 的到期提醒被改掉或搬走了');
  const open = src.lastIndexOf('`', marker);
  const close = src.indexOf('`', marker);
  assert.ok(open > 0 && close > marker, 'SQL 字串邊界抓不到');
  const sql = src.slice(open + 1, close);
  assert.ok(/FROM\s+course_periods/i.test(sql), '抓到的不是課期查詢：' + sql.slice(0, 80));
  return sql;
}

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };

/** 建一個課期。daysToExpiry 可為負（已過期）。 */
async function makePeriod({ total = 6, used = 0, daysToExpiry = 30, status = 'active' }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO course_periods(id, coach_id, venue_id, total_sessions, used_sessions, status, expires_at)
     VALUES ($1, $2, 'B', $3, $4, $5, CURRENT_DATE + ($6 || ' days')::interval)`,
    [id, COACH, total, used, status, String(daysToExpiry)]);
  return id;
}

const COACH = randomUUID();

(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await pool.query(`
      CREATE TABLE coaches(id uuid PRIMARY KEY, name text);
      CREATE TABLE course_periods(id uuid PRIMARY KEY, coach_id uuid, venue_id text,
        course_type int DEFAULT 1, total_sessions int, used_sessions int,
        status text DEFAULT 'active', expires_at date);
      CREATE TABLE admin_settings(key text PRIMARY KEY, value text);
    `);
    await pool.query('INSERT INTO coaches(id,name) VALUES ($1,$2)', [COACH, '測試教練']);
    await pool.query("INSERT INTO admin_settings(key,value) VALUES ('expiry_notice_days','60')");

    const sql = extractExpirySql();

    const stillHasSessions = await makePeriod({ total: 6, used: 2, daysToExpiry: 30 });
    const usedUpExactly = await makePeriod({ total: 6, used: 6, daysToExpiry: 30 });
    const usedUpOver = await makePeriod({ total: 6, used: 7, daysToExpiry: 30 });
    const alreadyExpired = await makePeriod({ total: 6, used: 1, daysToExpiry: -5 });
    const tooFarOut = await makePeriod({ total: 6, used: 1, daysToExpiry: 90 });
    const notActive = await makePeriod({ total: 6, used: 1, daysToExpiry: 30, status: 'refunded' });
    const dayOne = await makePeriod({ total: 6, used: 1, daysToExpiry: 1 });
    const exactlySixty = await makePeriod({ total: 6, used: 1, daysToExpiry: 60 });

    const picked = new Set((await pool.query(sql)).rows.map((r) => r.id));

    await t('A 還有堂數沒上完 → 會提醒', async () => {
      assert.ok(picked.has(stillHasSessions), '2/6 堂的課期沒有被選中');
    });

    await t('A 堂數剛好用完 → 不提醒', async () => {
      assert.ok(!picked.has(usedUpExactly),
        '6/6 堂的課期仍然被選中 —— 上完了還催家長續約');
    });

    await t('A 堂數超用（資料異常）→ 也不提醒', async () => {
      assert.ok(!picked.has(usedUpOver), '7/6 堂的課期仍然被選中');
    });

    await t('B 已經過期的 → 不提醒', async () => {
      assert.ok(!picked.has(alreadyExpired), '已過期的課期仍然被選中');
    });

    await t('B 還很久才到期（超過設定天數）→ 不提醒', async () => {
      assert.ok(!picked.has(tooFarOut), '90 天後才到期的課期被提早選中了');
    });

    await t('B 非 active 的課期 → 不提醒', async () => {
      assert.ok(!picked.has(notActive), 'refunded 的課期仍然被選中');
    });

    await t('C 區間比對：第 1 天與第 60 天都要選中（不是只有剛好第 60 天）', async () => {
      assert.ok(picked.has(dayOne),
        '明天就到期的課期沒被選中 —— 等號比對的老問題還在，cron 漏跑一天就永遠不補');
      assert.ok(picked.has(exactlySixty), '剛好第 60 天的課期沒被選中');
    });

    await t('獨立重算：選中的集合＝自己算一遍的集合', async () => {
      const want = (await pool.query(
        `SELECT id FROM course_periods
          WHERE status = 'active'
            AND used_sessions < total_sessions
            AND expires_at >= CURRENT_DATE
            AND expires_at <= CURRENT_DATE + INTERVAL '60 days'
          ORDER BY id`)).rows.map((r) => r.id);
      assert.deepEqual([...picked].sort(), want.sort());
    });

    console.log(`\n${passed} 個測試全數通過`);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    await admin.end();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
