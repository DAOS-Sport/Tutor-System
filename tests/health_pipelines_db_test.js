'use strict';
/**
 * 健康 API 的收集器對真的 PostgreSQL（拋棄式測試庫，已跑過 bootstrap）：
 * 每一支查詢都要能在現行 schema 上執行，種下的狀況要變成預期的燈號。
 * 全部在一個交易裡做，最後 ROLLBACK，不留任何資料。時間固定在 2031 年，避開庫裡既有的列。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');
process.env.DATABASE_URL = url;

const ROOT = path.join(__dirname, '..');
const { pool } = require(path.join(ROOT, 'server/models/db'));
const slots = require(path.join(ROOT, 'server/cron/slots'));
const rules = require(path.join(ROOT, 'server/services/healthRules'));
const { collectSignals } = require(path.join(ROOT, 'server/services/healthSignals'));
const { contractProblems } = require('./fixtures/health_contract');

const T = (taipei) => new Date(`${taipei}+08:00`);
const NOW = T('2031-03-05T10:00:00');
let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

console.log('health_pipelines_db_test');

(async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const slot = async (name, slotKey, status, { started, finished, result, error } = {}) => {
      await db.query(
        `INSERT INTO job_runs (id, job_name, holder_id, status, triggered_by, started_at, finished_at, error_message, result_summary)
         VALUES ($1, $2, 'health-test', $3, 'cron', $4, $5, $6, $7::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at, error_message = EXCLUDED.error_message, result_summary = EXCLUDED.result_summary`,
        [slots.slotRunId(name, slotKey), slots.JOB_PREFIX + name, status, started, finished, error || null,
          JSON.stringify({ slot: slotKey, result: result ?? null })]);
    };
    for (const job of rules.DAILY_JOBS) {
      const keys = rules.slotsToJudge(job.hhmm, NOW);
      const t = rules.slotTime(keys.previous);
      await slot(job.name, keys.previous, 'success', { started: t, finished: new Date(t.getTime() + 60e3), result: {} });
      if (['ragic_backup', 'ragic_pull', 'expiry_reminder'].includes(job.name)) continue;
      const c = rules.slotTime(keys.current);
      await slot(job.name, keys.current, 'success', { started: c, finished: new Date(c.getTime() + 60e3), result: { synced: 1 } });
    }
    const pullKeys = rules.slotsToJudge('02:30', NOW);
    await slot('ragic_pull', pullKeys.current, 'error', { started: T('2031-03-05T02:30:00'), finished: T('2031-03-05T02:31:00'), error: 'boom' });

    const backupKeys = rules.slotsToJudge('00:30', NOW);
    await slot('ragic_backup', backupKeys.current, 'success', {
      started: T('2031-03-05T00:30:00'), finished: T('2031-03-05T00:31:00'), result: { synced: 7, error: '2 筆同步失敗', retry: false } });
    const oldId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const newId = 'aaaaaaaa-0000-4000-8000-000000000002';
    const fail = (id, at) => db.query(
      `INSERT INTO ragic_sync_failures (job_name, form_code, entity_kind, local_id, error_kind, message, occurred_at)
       VALUES ('backup', 'Z01_Z02_BACKUP', 'student', $1, 'permanent', 'RAGIC_VALIDATION_ERROR', $2)`, [id, at]);
    await fail(oldId, T('2031-03-02T00:30:30'));
    await fail(oldId, T('2031-03-05T00:30:30'));
    await fail(newId, T('2031-03-05T00:30:40'));

    for (const [status, reason] of [['sent', null], ['sent', null], ['sent', null], ['failed', 'HTTP 500'], ['failed', 'HTTP 500'], ['failed', 'HTTP 500']]) {
      await db.query(`INSERT INTO line_push_log (at, event, recipient_uid, status, reason) VALUES ($1, 'health_test', 'U0', $2, $3)`,
        [T('2031-03-05T09:00:00'), status, reason]);
    }
    await db.query(`INSERT INTO admin_settings (key, value) VALUES ('push_enabled', 1)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

    await db.query(
      `INSERT INTO mail_outbox (kind, ref_id, recipient, status, created_at, updated_at)
       VALUES ('health_test', 'r1', 'x@example.invalid', 'pending', $1, $1)`, [T('2031-03-05T09:00:00')]);

    for (let i = 0; i < 3; i++) {
      await db.query(`INSERT INTO ragic_webhook_attempts (received_at, method, status, outcome) VALUES ($1, 'POST', 401, 'unauthorized')`,
        [T('2031-03-05T08:00:00')]);
    }

    const ct = await db.query(`SELECT course_type, pricing_zone_id FROM course_type_configs LIMIT 1`);
    if (ct.rowCount) {
      await db.query(
        `UPDATE course_type_configs SET pending_changes = '{}'::jsonb, scheduled_effective_date = $3
          WHERE course_type = $1 AND pricing_zone_id IS NOT DISTINCT FROM $2`,
        [ct.rows[0].course_type, ct.rows[0].pricing_zone_id, T('2031-03-05T09:00:00')]);
    }

    // 同一個交易裡的查詢要排隊送：pg 不允許同一個 client 同時跑多支查詢。
    let chain = Promise.resolve();
    const serial = { query: (...args) => { const r = chain.then(() => db.query(...args)); chain = r.catch(() => {}); return r; } };
    process.env.LINE_MESSAGING_TOKEN_dreams400 = 'health-test-token';
    const signals = await collectSignals(NOW, { db: serial });
    const report = rules.assembleReport(signals);
    const byId = Object.fromEntries(report.pipelines.map((p) => [p.id, p]));

    await check('每一支查詢都能在現行 schema 上執行（沒有「讀取狀態失敗」）', () => {
      const unreadable = report.pipelines.filter((p) => /讀取狀態失敗|讀不到/.test(p.reason)).map((p) => `${p.id}: ${p.reason}`);
      assert.deepEqual(unreadable, []);
      assert.equal(byId.database.level, 'green', byId.database.reason);
    });

    await check('報告符合 health-v1', () => assert.deepEqual(contractProblems(report), []));

    await check('每日排程：拋錯紅、這一輪還沒跑但上一輪成功黃、其餘綠', () => {
      assert.equal(byId['job.ragic_pull'].level, 'red', byId['job.ragic_pull'].reason);
      assert.equal(byId['job.expiry_reminder'].level, 'yellow', byId['job.expiry_reminder'].reason);
      for (const name of ['ragic_outbox_nightly', 'ragic_staff_venues', 'mgm_trial_today', 'eval_threshold_alert']) {
        assert.equal(byId['job.' + name].level, 'green', `${name}: ${byId['job.' + name].reason}`);
      }
      assert.equal(byId['job.ragic_pull'].lastFailureAt, T('2031-03-05T02:31:00').toISOString());
    });

    await check('寫回 Ragic：7 天內新出現 1 筆拒收 → 黃；改成兩筆都是舊的 → 綠', async () => {
      assert.equal(byId['job.ragic_backup'].level, 'yellow', byId['job.ragic_backup'].reason);
      assert.match(byId['job.ragic_backup'].reason, /2 筆被 Ragic 拒收，其中 1 筆是 7 天內新出現的/);
      await fail(newId, T('2031-03-01T00:30:30'));
      const again = rules.assembleReport(await collectSignals(NOW, { db: serial })).pipelines.find((p) => p.id === 'job.ragic_backup');
      assert.equal(again.level, 'green', again.reason);
    });

    await check('LINE 推播：有 token 時，24 小時 6 則失敗 3 則 → 紅（失敗過半）', () => {
      assert.equal(signals.linePush.last24h.sent, 3);
      assert.equal(signals.linePush.last24h.failed, 3);
      assert.equal(byId['line.push'].level, 'red', byId['line.push'].reason);
      assert.match(byId['line.push'].reason, /失敗過半/);
    });

    await check('Ragic 即時通知：24 小時 3 次全部 401 → 紅', () => {
      assert.equal(signals.ragicWebhook.attempts24h.unauthorized, 3);
      assert.equal(byId['ragic.webhook'].level, 'red', byId['ragic.webhook'].reason);
    });

    await check('對帳通知信：卡在待寄超過 30 分鐘的那封有算到', () => {
      assert.equal(signals.mail.stalePending, 1);
      assert.notEqual(byId['mail.reconcile'].level, 'green', byId['mail.reconcile'].reason);
    });

    await check('課程需求排程：到期 1 小時未套用 → 紅（庫裡沒有課程需求列時略過）', () => {
      if (!ct.rowCount) return;
      assert.ok(signals.courseTypeSchedule.overdue >= 1);
      assert.equal(byId['course-type.schedule'].level, 'red', byId['course-type.schedule'].reason);
    });

    await check('佇列與聊天室的計數是數字', () => {
      assert.ok(Array.isArray(signals.ragicOutbox.open));
      assert.equal(typeof signals.chatRooms.missing, 'number');
    });
  } finally {
    await db.query('ROLLBACK').catch((e) => console.error('ROLLBACK failed: ' + e.message));
    db.release();
    await pool.end();
  }
  if (failures) console.error('\nhealth_pipelines_db_test: ' + failures + ' FAILED');
  else console.log('\nhealth_pipelines_db_test: ALL PASS');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
