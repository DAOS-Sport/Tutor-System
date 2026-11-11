'use strict';
/** 定時推送的燈號與唯讀收集：DB 全部使用替身，不載入真實連線或呼叫外部服務。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const rules = require('../server/services/healthRules');
const NOW = new Date('2026-11-11T04:00:00Z');
const MINUTE = 60e3;
const ago = (minutes) => new Date(NOW.getTime() - minutes * MINUTE);
const context = (extra = {}) => ({ now: NOW, schedulerActive: true, ...extra });
const job = { name: 'line_bot_webhook', intervalMs: 5 * MINUTE };
const signal = (extra = {}) => ({
  configured: true,
  latest: { status: 'success', started_at: ago(2), finished_at: ago(1) },
  lastSuccessAt: ago(1),
  lastFailureAt: null,
  unsuccessfulSince: null,
  hasChanges: false,
  ...extra,
});
const evaluate = (s, ctx = context()) => {
  assert.equal(typeof rules.evaluateIntervalJob, 'function', '缺少定時工作燈號規則');
  return rules.evaluateIntervalJob(job, s, ctx);
};

// 只以明列替身載入本機模組；若新增未列依賴，測試直接失敗。
function isolatedModule(relative, dependencies) {
  const filename = path.join(ROOT, relative);
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer,
    process: { env: {}, uptime: () => 0 }, Date, setTimeout, clearTimeout,
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `不可載入未替換依賴：${relative} -> ${id}`);
      return dependencies[id];
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return module.exports;
}

function collector({ changed = false, rows = {}, lineFailure = false } = {}) {
  const queries = [];
  const cursor = '2026-11-10T04:00:00.000Z';
  const yzCursor = Buffer.from(`${cursor}|fake-order`).toString('base64url');
  const db = { async query(sql, params = []) {
    queries.push({ sql, params });
    assert.match(sql.trim(), /^(SELECT|WITH)\b/i, '健康收集器只能讀取');
    if (/WITH history AS/.test(sql)) return { rows: [rows[params[0]] || {
      status: 'success', started_at: ago(24 * 60), finished_at: ago(24 * 60),
      last_success: ago(24 * 60), last_failure: null, unsuccessful_since: null,
    }] };
    if (/result_summary->>'cursor'/.test(sql)) return { rows: [{ cursor: params[0] === 'line_bot_webhook' ? cursor : yzCursor }] };
    if (/SELECT EXISTS \(SELECT 1 FROM admin_enrollments/.test(sql)) {
      if (lineFailure) throw new Error('虛構的變動預檢失敗');
      return { rows: [{ changed }] };
    }
    if (/SELECT 1 FROM admin_enrollments/.test(sql)) return { rows: changed ? [{ '?column?': 1 }] : [] };
    if (/FROM job_runs/.test(sql)) return { rows: [] };
    if (/FROM line_push_log/.test(sql)) return { rows: [{ sent: 0, failed: 0 }] };
    if (/FROM mail_outbox/.test(sql)) return { rows: [{ sent: 0, failed: 0, stale_pending: 0 }] };
    if (/FROM course_type_configs|FROM course_periods/.test(sql)) return { rows: [{ n: 0, oldest: null }] };
    if (/MAX\(completed_at\)/.test(sql)) return { rows: [{ at: null }] };
    return { rows: [] };
  } };
  const noPool = { pool: { query() { throw new Error('不得使用真實 DB 或預設 pool'); } } };
  const crypto = require('node:crypto');
  const line = isolatedModule('server/services/lineBotSync.js', {
    crypto, '../models/db': noPool, '../routes/sessions': { coachOrders: {} }, './yazhengLegacy': {},
  });
  const yazheng = isolatedModule('server/services/yazhengSync.js', { crypto, '../models/db': noPool });
  // webhookConfig 的環境也使用替身，不讀取本機憑證。
  const configured = (service) => ({ ...service, webhookConfig: () => ({}) });
  const signals = isolatedModule('server/services/healthSignals.js', {
    path, '../models/db': noPool, './healthRules': rules,
    '../cron/slots': { JOB_PREFIX: 'slot:', slotRunId: (name, key) => `${name}/${key}` },
    '../build-info.json': { sha: 'interval-test' },
    './lineBotSync': configured(line), './yazhengSync': configured(yazheng),
    './ragicAdmin': { ragicEnabled: () => false },
    './pushGate': { describe: async () => ({ enabled: false }) },
    './line': { tokenSummary: () => ({}) },
    './mailer': { describe: () => ({ configured: false }) },
    './reconcileMailSweep': { isEnabled: () => false },
    './objectStorage': { driverName: 'db' },
  });
  return { db, queries, collect: () => signals.collectSignals(NOW, { db }) };
}

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${label}`); }
  catch (error) { failed += 1; console.error(`  FAIL ${label}\n       ${error.message}`); }
}

(async () => {
  console.log('health_interval_jobs_test');
  await check('兩條增量推送都是每 5 分鐘，常數與真實 cron 相符', () => {
    assert.equal(rules.INTERVAL_FAILURE_LIMIT, 3);
    assert.deepEqual(rules.INTERVAL_JOBS.map(({ name, intervalMs }) => ({ name, intervalMs })), [
      { name: 'line_bot_webhook', intervalMs: 5 * MINUTE },
      { name: 'yazheng_webhook', intervalMs: 5 * MINUTE },
    ]);
    const cron = fs.readFileSync(path.join(ROOT, 'server/cron/index.js'), 'utf8');
    for (const service of ['lineBotSync', 'yazhengSync']) {
      const body = `if (!${service}.webhookConfig()) return;`;
      assert.ok(cron.includes(body));
      const start = cron.lastIndexOf("scheduleTaipei('*/5 * * * *'", cron.indexOf(body));
      assert.ok(start >= 0 && cron.slice(start, cron.indexOf(body)).length < 100);
      assert.match(cron.slice(cron.indexOf(body), cron.indexOf(body) + 250), /hasChanges\(\)/);
    }
  });
  await check('新管線各一條；共享 ragic_sync 與已退役工作不重列', () => {
    for (const name of ['line_bot_webhook', 'yazheng_webhook']) {
      assert.equal(rules.PIPELINES.filter((p) => p.id === `job.${name}`).length, 1);
    }
    assert.ok(!rules.PIPELINES.some((p) => ['job.ragic_sync', 'job.ragic_quarantine'].includes(p.id)));
  });
  await check('skipped_lock 是上一輪仍在跑，維持綠並保留最後失敗時間', () => {
    const s = signal({ latest: { status: 'skipped_lock', started_at: ago(1) }, hasChanges: true, lastFailureAt: ago(60), unsuccessfulSince: ago(60) });
    const r = evaluate(s);
    assert.equal(r.level, 'green');
    assert.equal(r.lastFailureAt, ago(60).toISOString());
  });
  await check('閒置一天後剛發生一次 error 為黃，不以舊成功時間誤紅', () => {
    assert.equal(evaluate(signal({ latest: { status: 'error', started_at: ago(1) }, hasChanges: true,
      lastSuccessAt: ago(24 * 60), lastFailureAt: ago(1), unsuccessfulSince: ago(1) })).level, 'yellow');
  });
  await check('連續未成功尚未滿 3 個間隔為黃', () => {
    assert.equal(evaluate(signal({ latest: { status: 'error', started_at: ago(1) }, hasChanges: true,
      unsuccessfulSince: new Date(NOW.getTime() - 15 * MINUTE + 1) })).level, 'yellow');
  });
  await check('仍有待送變動且連續 3 個間隔未成功才紅', () => {
    const r = evaluate(signal({ latest: { status: 'error', started_at: ago(1) }, hasChanges: true, unsuccessfulSince: ago(15) }));
    assert.equal(r.level, 'red');
    assert.match(r.reason, /3.*間隔/);
  });
  await check('完全沒有紀錄為黃，包含無待送資料', () => {
    const r = evaluate(signal({ latest: null, lastSuccessAt: null, hasChanges: false }));
    assert.equal(r.level, 'yellow');
    assert.match(r.reason, /無法觀測/);
  });
  await check('schedulerActive=false 時為黃', () => {
    assert.equal(evaluate(signal({ hasChanges: true, unsuccessfulSince: ago(60) }), context({ schedulerActive: false })).level, 'yellow');
  });
  await check('無變動不寫 job_runs，舊成功與舊錯誤都不會造成閒置誤紅', () => {
    assert.equal(evaluate(signal({ latest: { status: 'error', started_at: ago(60) },
      lastSuccessAt: ago(24 * 60), unsuccessfulSince: ago(60), hasChanges: false })).level, 'green');
  });
  await check('剛開始的 running 為綠', () => {
    assert.equal(evaluate(signal({ latest: { status: 'running', started_at: ago(1) }, hasChanges: true, unsuccessfulSince: ago(1) })).level, 'green');
  });
  await check('running 持續 3 個間隔仍未成功且有待送為紅', () => {
    assert.equal(evaluate(signal({ latest: { status: 'running', started_at: ago(15) }, hasChanges: true, unsuccessfulSince: ago(15) })).level, 'red');
  });
  await check('有待送但沒有未成功起點，維持黃等下一輪', () => {
    assert.equal(evaluate(signal({ lastSuccessAt: ago(24 * 60), hasChanges: true })).level, 'yellow');
  });
  await check('未設定 webhook 為黃而非成功', () => {
    const r = evaluate(signal({ configured: false }));
    assert.equal(r.level, 'yellow');
    assert.match(r.reason, /無法觀測/);
  });
  await check('讀取失敗沿用既有規則為紅', () => {
    assert.equal(evaluate({ readError: '虛構失敗' }).level, 'red');
  });
  await check('假 DB 執行兩個 service 的真實 hasChanges SQL，閒置不誤紅', async () => {
    const test = collector();
    const s = await test.collect();
    assert.equal(s.intervalJobs?.line_bot_webhook?.hasChanges, false);
    assert.equal(s.intervalJobs?.yazheng_webhook?.hasChanges, false);
    const sql = test.queries.map((q) => q.sql).join('\n');
    assert.match(sql, /FROM coaches/);
    assert.match(sql, /FROM admin_staff/);
    assert.match(sql, /FROM yz_legacy_links/);
    assert.match(sql, /FROM yz_legacy_packages/);
    assert.match(sql, /ae\.id::text/);
    assert.match(sql, /status IN \('running', 'error', 'aborted'\)/);
    assert.match(sql, /started_at > history\.last_success/);
    const ps = rules.assembleReport(s).pipelines.filter((p) => /job\.(line_bot|yazheng)_webhook/.test(p.id));
    assert.equal(ps.length, 2);
    assert.ok(ps.every((p) => p.level === 'green'));
  });
  await check('假 DB 的連續未成功起點接入燈號，兩條管線皆紅', async () => {
    const failedRow = { status: 'error', started_at: ago(1), finished_at: ago(1), last_success: ago(60),
      last_failure: ago(1), unsuccessful_since: ago(15) };
    const test = collector({ changed: true, rows: { line_bot_webhook: failedRow, yazheng_webhook: failedRow } });
    const report = rules.assembleReport(await test.collect());
    const ps = report.pipelines.filter((p) => /job\.(line_bot|yazheng)_webhook/.test(p.id));
    assert.equal(ps.length, 2);
    assert.ok(ps.every((p) => p.level === 'red'));
  });
  await check('一條變動預檢失敗不遮掉另一條成功訊號', async () => {
    const test = collector({ lineFailure: true });
    const s = await test.collect();
    assert.match(s.intervalJobs?.line_bot_webhook?.readError || '', /虛構的變動預檢失敗/);
    assert.equal(s.intervalJobs?.yazheng_webhook?.hasChanges, false);
  });
  console.log(`\nhealth_interval_jobs_test: ${passed} PASS, ${failed} FAILED`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
