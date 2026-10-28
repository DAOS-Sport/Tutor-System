'use strict';
// 每日排程「時段認領＋補跑」（GitHub Tutor-System #10）。
// 真 PostgreSQL（拋棄式測試庫）、不啟動伺服器、不打 Ragic／LINE；只用 slottest_ 前綴的 job_runs 列，結束全刪。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');
process.env.DATABASE_URL = url;

const slots = require('../server/cron/slots');
const { pool } = require('../server/models/db');

const PREFIX = `slottest_${Date.now().toString(36)}_`;
const T = (iso) => new Date(iso);
let passed = 0;
const ok = (label) => { passed += 1; console.log('  PASS ' + label); };

(async () => {
  try {
    // 1. 時段計算（台北時間）
    assert.equal(slots.slotRunId('a', '2026-10-14T00:30'), slots.slotRunId('a', '2026-10-14T00:30'));
    assert.notEqual(slots.slotRunId('a', '2026-10-14T00:30'), slots.slotRunId('a', '2026-10-15T00:30'));
    assert.notEqual(slots.slotRunId('a', '2026-10-14T00:30'), slots.slotRunId('b', '2026-10-14T00:30'));
    assert.match(slots.slotRunId('a', 'x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(slots.latestDueSlot('00:30', T('2026-10-13T16:29:00Z')), { slotKey: '2026-10-13T00:30', date: '2026-10-13' });
    assert.deepEqual(slots.latestDueSlot('00:30', T('2026-10-13T16:31:00Z')), { slotKey: '2026-10-14T00:30', date: '2026-10-14' });
    assert.equal(slots.slotTimeMs('2026-10-14T00:30'), Date.parse('2026-10-13T16:30:00Z'));
    ok('時段以台北時間計算：台北 00:29 屬前一天的時段、00:31 屬當天');

    // 2. 多台同時觸發同一時段只跑一次
    let count = 0;
    const slow = async () => { count += 1; await new Promise((r) => setTimeout(r, 150)); return { done: true }; };
    const jc = PREFIX + 'concurrent';
    const rs = await Promise.all(Array.from({ length: 5 }, () => slots.runSlot(jc, '2026-10-14T00:30', slow, { triggeredBy: 'cron' })));
    assert.equal(count, 1);
    assert.equal(rs.filter((r) => r.status === 'success').length, 1);
    assert.equal(rs.filter((r) => r.status === 'skipped_slot').length, 4);
    const rows = (await pool.query(`SELECT status, result_summary FROM job_runs WHERE job_name = $1`, [slots.JOB_PREFIX + jc])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'success');
    assert.equal(rows[0].result_summary.slot, '2026-10-14T00:30');
    ok('5 台同時觸發同一時段只執行 1 次，job_runs 只有 1 列且記下時段');

    // 3. retry 會重新認領；error 不自動重跑
    let r1 = 0;
    const jr = PREFIX + 'retry';
    assert.equal((await slots.runSlot(jr, 'S1', async () => { r1 += 1; return { retry: true }; })).status, 'retry');
    assert.equal((await slots.runSlot(jr, 'S1', async () => { r1 += 1; return { ok: 1 }; })).status, 'success');
    assert.equal((await slots.runSlot(jr, 'S1', async () => { r1 += 1; })).status, 'skipped_slot');
    assert.equal(r1, 2);
    let e1 = 0;
    const je = PREFIX + 'error';
    assert.equal((await slots.runSlot(je, 'S1', async () => { e1 += 1; throw new Error('boom'); })).status, 'error');
    assert.equal((await slots.runSlot(je, 'S1', async () => { e1 += 1; })).status, 'skipped_slot');
    assert.equal(e1, 1);
    const errRow = (await pool.query(`SELECT status, error_message FROM job_runs WHERE job_name = $1`, [slots.JOB_PREFIX + je])).rows[0];
    assert.deepEqual(errRow, { status: 'error', error_message: 'boom' });
    ok('回傳 retry（例如 Ragic 鎖被占用）下一輪會重跑；拋錯記成 error、不自動重跑');

    // 4. 卡在執行中超過 2 小時可接手，5 分鐘內的不搶
    const js = PREFIX + 'stale';
    const jf = PREFIX + 'fresh';
    await pool.query(`INSERT INTO job_runs (id, job_name, holder_id, status, triggered_by, started_at)
      VALUES ($1, $2, 'dead-host', 'running', 'cron', NOW() - interval '3 hours')`, [slots.slotRunId(js, 'S1'), slots.JOB_PREFIX + js]);
    await pool.query(`INSERT INTO job_runs (id, job_name, holder_id, status, triggered_by, started_at)
      VALUES ($1, $2, 'busy-host', 'running', 'cron', NOW() - interval '5 minutes')`, [slots.slotRunId(jf, 'S1'), slots.JOB_PREFIX + jf]);
    assert.equal((await slots.runSlot(js, 'S1', async () => ({}))).status, 'success');
    assert.equal((await slots.runSlot(jf, 'S1', async () => ({}))).status, 'skipped_slot');
    ok('執行中超過 2 小時（那台當掉）可接手；5 分鐘內仍在執行的不搶');

    // 5. 補跑
    const ran = [];
    const mk = (name, hhmm, catchUp = 'any') => ({ name: PREFIX + name, hhmm, catchUp,
      catchUpUntil: catchUp === 'same_day' ? '20:00' : null, fn: async () => { ran.push(name); return {}; } });
    const jobs = [mk('outbox', '00:10'), mk('backup', '00:30'), mk('pull', '02:30'), mk('expiry', '09:00', 'same_day')];
    let out = await slots.runMissedDailySlots(jobs, T('2026-10-14T06:00:00Z')); // 台北 10/14 14:00 上線
    assert.equal(ran.length, 0);
    assert.equal(out.outcomes.filter((o) => o.status === 'seeded').length, 4);
    out = await slots.runMissedDailySlots(jobs, T('2026-10-15T00:00:00Z')); // 台北 10/15 08:00，夜間全部沒人跑
    assert.deepEqual(ran, ['outbox', 'backup', 'pull']);
    assert.deepEqual(out.outcomes.map((o) => o.status), ['success', 'success', 'success']);
    const trig = (await pool.query(`SELECT DISTINCT triggered_by FROM job_runs WHERE job_name = $1 AND status = 'success'`,
      [slots.JOB_PREFIX + PREFIX + 'backup'])).rows.map((r) => r.triggered_by);
    assert.deepEqual(trig, ['catchup']);
    await slots.runMissedDailySlots(jobs, T('2026-10-15T00:05:00Z'));
    assert.deepEqual(ran, ['outbox', 'backup', 'pull']);
    await slots.runMissedDailySlots(jobs, T('2026-10-15T01:01:00Z')); // 台北 09:01：寬限 3 分鐘內不搶
    assert.equal(ran.includes('expiry'), false);
    await slots.runMissedDailySlots(jobs, T('2026-10-15T01:10:00Z')); // 台北 09:10：補當天 09:00
    assert.equal(ran.filter((x) => x === 'expiry').length, 1);
    await slots.runMissedDailySlots(jobs, T('2026-10-16T00:00:00Z')); // 隔天清晨：不補前一天的推播類
    assert.equal(ran.filter((x) => x === 'expiry').length, 1);
    ok('補跑：上線只記起點；錯過的時段依登記順序補跑一次不重複；推播類只補當天，預定時間 3 分鐘內不搶');

    // 6. 跨台順序：前一支還在別台執行中就停下這一輪；推播類 20:00 以後不補
    const ran2 = [];
    const mk2 = (name, hhmm, catchUp = 'any') => ({ name: PREFIX + 'b_' + name, hhmm, catchUp,
      catchUpUntil: catchUp === 'same_day' ? '20:00' : null, fn: async () => { ran2.push(name); return {}; } });
    const chain = [mk2('outbox', '00:10'), mk2('backup', '00:30'), mk2('expiry', '09:00', 'same_day')];
    await slots.runMissedDailySlots(chain, T('2026-10-14T06:00:00Z')); // 上線記起點
    await pool.query(`INSERT INTO job_runs (id, job_name, holder_id, status, triggered_by) VALUES ($1, $2, 'other-host', 'running', 'cron')`,
      [slots.slotRunId(PREFIX + 'b_outbox', '2026-10-15T00:10'), slots.JOB_PREFIX + PREFIX + 'b_outbox']); // 另一台正在跑回寫佇列
    out = await slots.runMissedDailySlots(chain, T('2026-10-14T16:40:00Z')); // 台北 10/15 00:40
    assert.deepEqual(ran2, []);
    assert.deepEqual(out.outcomes.map((o) => o.status), ['waiting']);
    await pool.query(`UPDATE job_runs SET status = 'success', finished_at = NOW() WHERE id = $1`, [slots.slotRunId(PREFIX + 'b_outbox', '2026-10-15T00:10')]);
    await slots.runMissedDailySlots(chain, T('2026-10-14T16:45:00Z')); // 回寫佇列結束後才補備份
    assert.deepEqual(ran2, ['backup']);
    await slots.runMissedDailySlots(chain, T('2026-10-15T12:30:00Z')); // 台北 10/15 20:30：推播類過了 20:00 不補
    assert.deepEqual(ran2, ['backup']);
    ok('跨台順序：前一支還在別台執行中就停下這一輪，結束後才補下一支；推播類 20:00 以後不補');

    // 7. cron/index.js 登記的時段與 cron 運算式一致
    const src = fs.readFileSync(path.join(__dirname, '../server/cron/index.js'), 'utf8');
    const re = /scheduleTaipei\('(\d+) (\d+) \* \* \*', slots\.daily\('([a-z_]+)', '(\d{2}):(\d{2})'/g;
    let m;
    let k = 0;
    while ((m = re.exec(src))) {
      k += 1;
      assert.equal(Number(m[1]), Number(m[5]), `${m[3]} 分鐘不一致`);
      assert.equal(Number(m[2]), Number(m[4]), `${m[3]} 小時不一致`);
    }
    assert.equal(k, 10); // 2026-10-22 加 yazheng_snapshot（01:30）；2026-10-28 加 line_bot_snapshot（01:45）
    ok('cron/index.js 的 10 支每日排程：cron 運算式與登記時段一致');
  } finally {
    await pool.query(`DELETE FROM job_runs WHERE job_name LIKE $1`, [slots.JOB_PREFIX + PREFIX + '%']).catch(() => {});
    await pool.end();
  }
  console.log(`cron_slots_db_test: ${passed} 項通過`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
