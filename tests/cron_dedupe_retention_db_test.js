'use strict';
// GitHub #10 補強：多台 autoscale 下「不重複」與「驗證紀錄保留期」。
//
// 守的契約：
//   A. 多個「行程」（不是同一行程裡的 Promise）同時跑補跑檢查，錯過的時段只執行一次
//      —— cron_slots_db_test 只在單一行程內驗並發；這支用 child_process 模擬真的多台。
//   B. 期末評鑑 7 天提醒：多台同時在 :05 取清單，同一筆只會交給一台（不重複推播）；
//      推播失敗（reminder_sent_at 沒寫上）時，租約過期後下一輪可重新認領重試。
//   C. ragic_z01_uid_schema_verifications 保留期：超過 N 天的刪掉，但永遠保留
//      「最新一列」（新鮮度判斷依據）與「最新一列 verified」；保留天數有上下限。
//
// 拋棄式本機測試庫；B、C 用獨立 schema 的合成資料，A 只用 slottest_ 前綴的 job_runs 列，結束全刪。
// 不打 Ragic／LINE。
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');
process.env.DATABASE_URL = url;

const { Pool } = require('../server/node_modules/pg');
const slots = require('../server/cron/slots');
const { pool: appPool } = require('../server/models/db');
const evaluations = require('../server/services/evaluations');
const freshness = require('../server/services/ragicSchemaFreshness');

const schema = 'cron_dedupe_' + randomUUID().replaceAll('-', '');
const PREFIX = `slottest_mp_${Date.now().toString(36)}_`;
const admin = new Pool({ connectionString: url });
const db = new Pool({ connectionString: url, max: 6, options: `-c search_path=${schema},public -c statement_timeout=10000` });

let passed = 0;
const ok = (label) => { passed += 1; console.log('  PASS ' + label); };

/** 開一個獨立 node 行程跑補跑檢查（等同另一台 instance）。 */
function runCatchUpInChild(jobName, nowIso) {
  const script = `
    const slots = require(${JSON.stringify(path.join(__dirname, '../server/cron/slots'))});
    const { pool } = require(${JSON.stringify(path.join(__dirname, '../server/models/db'))});
    const job = { name: ${JSON.stringify(jobName)}, hhmm: '00:30', catchUp: 'any', catchUpUntil: null,
      fn: async () => {
        await pool.query('INSERT INTO ${schema}.exec_log(job, pid) VALUES ($1, $2)', [${JSON.stringify(jobName)}, process.pid]);
        await new Promise((r) => setTimeout(r, 300));
        return { pid: process.pid };
      } };
    slots.runMissedDailySlots([job], new Date(${JSON.stringify(nowIso)}))
      .then((r) => { process.stdout.write(JSON.stringify(r.outcomes)); return pool.end(); })
      .catch((e) => { console.error(e); process.exitCode = 1; });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`child exit ${code}: ${err}`))));
  });
}

(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await db.query(`
      CREATE TABLE exec_log(job text, pid int, at timestamptz DEFAULT NOW());
      CREATE TABLE course_periods(id uuid PRIMARY KEY, venue_id text);
      CREATE TABLE course_evaluations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        course_period_id uuid NOT NULL, parent_id uuid NOT NULL, coach_id uuid NOT NULL,
        invited_at timestamptz NOT NULL DEFAULT NOW(), reminder_sent_at timestamptz, submitted_at timestamptz);
      CREATE TABLE notification_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind varchar(40) NOT NULL,
        ref_id varchar(80) NOT NULL, recipient_uid varchar(100) NOT NULL, sent_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE(kind, ref_id, recipient_uid));
      CREATE TABLE ragic_z01_uid_schema_verifications (LIKE public.ragic_z01_uid_schema_verifications INCLUDING ALL);
    `);

    // ── A. 三個行程同時補跑同一個錯過的時段 → 只執行一次 ──
    const job = PREFIX + 'backup';
    // 上線起點（seed），之後的 00:30 時段沒有任何一台在線。
    await slots.claimSlot(job, '2026-10-14T00:30', 'seed', { status: 'seeded' });
    const outs = await Promise.all([1, 2, 3].map(() => runCatchUpInChild(job, '2026-10-15T01:00:00Z'))); // 台北 10/15 09:00
    const execs = (await db.query(`SELECT pid FROM exec_log WHERE job = $1`, [job])).rows;
    assert.equal(execs.length, 1, `應只執行 1 次，實際 ${execs.length}：${outs.join(' | ')}`);
    const runs = (await appPool.query(
      `SELECT status, triggered_by, result_summary->>'slot' AS slot FROM job_runs WHERE job_name = $1 AND status <> 'seeded'`,
      [slots.JOB_PREFIX + job])).rows;
    assert.deepEqual(runs, [{ status: 'success', triggered_by: 'catchup', slot: '2026-10-15T00:30' }]);
    // 之後任何一台再檢查都不會重跑。
    await runCatchUpInChild(job, '2026-10-15T01:05:00Z');
    assert.equal((await db.query(`SELECT 1 FROM exec_log WHERE job = $1`, [job])).rowCount, 1);
    ok('3 個獨立行程同時補跑錯過的 00:30 → 只執行 1 次、job_runs 記 catchup；之後再檢查不重跑');

    // ── B. 期末評鑑 7 天提醒的認領 ──
    const period = randomUUID();
    await db.query(`INSERT INTO course_periods(id, venue_id) VALUES ($1, 'B')`, [period]);
    const due = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await db.query(
        `INSERT INTO course_evaluations(course_period_id, parent_id, coach_id, invited_at)
         VALUES ($1, $2, $3, NOW() - INTERVAL '8 days') RETURNING id`, [period, randomUUID(), randomUUID()]);
      due.push(r.rows[0].id);
    }
    // 不該被挑中的：未滿 7 天、已提醒、已填寫
    await db.query(`INSERT INTO course_evaluations(course_period_id, parent_id, coach_id, invited_at) VALUES ($1,$2,$3, NOW() - INTERVAL '2 days')`, [period, randomUUID(), randomUUID()]);
    await db.query(`INSERT INTO course_evaluations(course_period_id, parent_id, coach_id, invited_at, reminder_sent_at) VALUES ($1,$2,$3, NOW() - INTERVAL '9 days', NOW())`, [period, randomUUID(), randomUUID()]);
    await db.query(`INSERT INTO course_evaluations(course_period_id, parent_id, coach_id, invited_at, submitted_at) VALUES ($1,$2,$3, NOW() - INTERVAL '9 days', NOW())`, [period, randomUUID(), randomUUID()]);

    const batches = await Promise.all([1, 2, 3].map(() => evaluations.listInvitesForReminder({ db })));
    const all = batches.flat().map((r) => r.id);
    assert.equal(all.length, 4, `3 台同時取清單，4 筆應各只交出一次，實際 ${all.length}`);
    assert.deepEqual([...new Set(all)].sort(), [...due].sort());
    assert.equal(batches.flat()[0].venue_id, 'B');
    // 同一輪內（租約內）再取 → 空的
    assert.deepEqual(await evaluations.listInvitesForReminder({ db }), []);
    ok('期末評鑑 7 天提醒：3 台同時取清單，每筆只交給一台；租約內再取不重複');

    // 一筆推播成功（寫 reminder_sent_at），其餘推播失敗；租約過期（模擬下一小時）後只重新交出失敗的。
    await db.query(`UPDATE course_evaluations SET reminder_sent_at = NOW() WHERE id = $1`, [due[0]]);
    await db.query(`UPDATE notification_log SET sent_at = NOW() - INTERVAL '31 minutes' WHERE kind = 'evaluation_reminder_claim'`);
    const retry = (await evaluations.listInvitesForReminder({ db })).map((r) => r.id).sort();
    assert.deepEqual(retry, due.slice(1).sort());
    ok('推播失敗的提醒在租約（30 分鐘）過後下一輪可重新認領重試；已送達的不再出現');

    // ── C. 驗證紀錄保留期 ──
    const now = new Date('2026-10-19T00:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const ins = (daysAgo, verified) => db.query(
      `INSERT INTO ragic_z01_uid_schema_verifications
         (fetched_at, endpoint, sheet_path, http_status, response_hash, field_id, correlation_id, verified, expires_at)
       VALUES ($1, 'e', 's', 200, $2, '1006846', $3, $4, $1::timestamptz + interval '15 minutes') RETURNING id`,
      [new Date(now.getTime() - daysAgo * day), 'a'.repeat(64), randomUUID(), verified]).then((r) => r.rows[0].id);
    // 情境 1：Ragic 已連續失敗 40 天 —— 最後一次通過是 45 天前。
    const lastVerified = await ins(45, true);
    await ins(50, true);
    await ins(44, false);
    const latestFailed = await ins(40, false); // 最新一列也超過保留期
    const removed = await freshness.pruneRagicZ01UidSchemaVerifications({ db, now, retentionDays: 30 });
    assert.equal(removed, 2);
    const left = (await db.query(`SELECT id FROM ragic_z01_uid_schema_verifications ORDER BY fetched_at`)).rows.map((r) => r.id);
    assert.deepEqual(left, [lastVerified, latestFailed], '最新一列與最新 verified 列必須保留');
    const latest = await freshness.getLatestRagicZ01UidSchemaEvidence({ db });
    assert.equal(latest.id, latestFailed, '清理不能改變新鮮度判斷讀到的那一列');

    // 情境 2：正常每 5 分鐘一列 —— 保留期內的全留，期外的全刪（批次上限生效）。
    await db.query(`DELETE FROM ragic_z01_uid_schema_verifications`);
    for (const d of [0, 1, 10, 29, 31, 60, 90]) await ins(d, true);
    assert.equal(await freshness.pruneRagicZ01UidSchemaVerifications({ db, now, retentionDays: 30, limit: 2 }), 2);
    assert.equal(await freshness.pruneRagicZ01UidSchemaVerifications({ db, now, retentionDays: 30 }), 1);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM ragic_z01_uid_schema_verifications`)).rows[0].n, 4);
    ok('驗證紀錄保留期：超過 N 天的刪除（分批）；永遠保留最新一列與最新 verified 列，新鮮度判斷不受影響');

    // 保留天數設定的上下限
    const saved = process.env.RAGIC_Z01_UID_SCHEMA_RETENTION_DAYS;
    try {
      const cases = [[undefined, 30], ['', 30], ['abc', 30], ['0', 7], ['-5', 7], ['3', 7], ['14', 14], ['90.7', 90], ['9999', 365]];
      for (const [raw, want] of cases) {
        if (raw === undefined) delete process.env.RAGIC_Z01_UID_SCHEMA_RETENTION_DAYS;
        else process.env.RAGIC_Z01_UID_SCHEMA_RETENTION_DAYS = raw;
        assert.equal(freshness.schemaRetentionDays(), want, `RETENTION_DAYS=${raw}`);
      }
    } finally {
      if (saved === undefined) delete process.env.RAGIC_Z01_UID_SCHEMA_RETENTION_DAYS;
      else process.env.RAGIC_Z01_UID_SCHEMA_RETENTION_DAYS = saved;
    }
    ok('保留天數 RAGIC_Z01_UID_SCHEMA_RETENTION_DAYS：預設 30、夾在 7–365 天，設錯不會清光稽核紀錄');

    // 驗證流程：寫入成功後順手清理；清理出錯不影響這次驗證結果。
    const calls = [];
    const flaky = {
      query: async (sql) => {
        calls.push(sql.trim().split(/\s+/)[0]);
        if (/^\s*DELETE/i.test(sql)) throw Object.assign(new Error('disk full'), { code: '53100' });
        return { rows: [], rowCount: 1 };
      },
    };
    const definition = { fields: { fid1006846: { name: freshness.UID_FIELD_NAME, attr_noDup: true } } };
    const evidence = await freshness.verifyRagicZ01UidSchemaFreshness({
      db: flaky,
      fetchDefinition: async () => ({ endpoint: 'e', sheetPath: 'https://example.invalid/z01', httpStatus: 200, data: definition }),
    });
    assert.equal(evidence.verified, true);
    assert.deepEqual(calls, ['INSERT', 'DELETE']);
    ok('驗證流程寫入後會清理；清理失敗只記 log，不讓驗證失敗、不暫停 UID 回寫');
  } finally {
    await appPool.query(`DELETE FROM job_runs WHERE job_name LIKE $1`, [slots.JOB_PREFIX + PREFIX + '%']).catch(() => {});
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
    await appPool.end();
  }
  console.log(`cron_dedupe_retention_db_test: ${passed} 項通過`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
