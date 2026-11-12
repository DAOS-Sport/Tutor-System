'use strict';
// 全部使用虛構資料與假的 db.query；HTTP 僅監聽本機隨機埠。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const health = require('../server/services/healthErrors');
const rules = require('../server/services/healthRules');
const NOW = new Date('2026-11-12T08:00:00Z');
const FIRST = '2026-11-12T06:00:00Z';
const LAST = '2026-11-12T07:00:00Z';
const DAY = 86400000;
const drilldown = () => require('../server/services/healthDrilldown');
const byId = (report, id) => report.pipelines.find((p) => p.id === id);

function fakeDb(evidenceRows = () => []) {
  const calls = [];
  return { calls, async query(query, values = []) {
    const evidence = typeof query === 'object';
    const text = evidence ? query.text : query;
    if (evidence) values = query.values;
    calls.push({ text, values, query_timeout: query.query_timeout, evidence });
    if (evidence) return { rows: await evidenceRows(text, values) };
    if (text === 'SELECT 1') return { rows: [{}] };
    if (/id = ANY/.test(text)) return { rows: values[0].map((id) => ({ id, status: 'success',
      started_at: FIRST, finished_at: LAST, result_summary: { result: { synced: 1 } } })) };
    if (/WITH history AS/.test(text)) return { rows: [{ status: 'success', started_at: FIRST, finished_at: LAST,
      last_success: LAST, last_failure: null, unsuccessful_since: null }] };
    if (/FROM line_push_log/.test(text)) return { rows: [{ sent: 1, failed: 0 }] };
    if (/FROM mail_outbox/.test(text)) return { rows: [{ sent: 1, failed: 0, stale_pending: 0 }] };
    if (/FROM course_type_configs|FROM course_periods/.test(text)) return { rows: [{ n: 0 }] };
    if (/FROM ragic_webhook_attempts/.test(text)) return { rows: [{ outcome: 'ok', n24: 1, last: LAST }] };
    if (/MAX\(completed_at\)/.test(text)) return { rows: [{ at: LAST }] };
    return { rows: [] };
  } };
}

// 執行真 healthSignals；依賴全以明列替身提供，禁止載入真 pool 或外部服務。
function signalsService(db) {
  const filename = path.join(__dirname, '../server/services/healthSignals.js');
  const module = { exports: {} };
  const dependencies = {
    path, '../models/db': { pool: db }, './healthRules': rules, './healthDrilldown': drilldown(),
    '../cron/slots': require('../server/cron/slots'), '../build-info.json': { sha: 'test-build' },
    './lineBotSync': { webhookConfig: () => ({}), hasChanges: async () => false },
    './yazhengSync': { webhookConfig: () => ({}), hasChanges: async () => false },
    './ragicAdmin': { ragicEnabled: () => false }, './pushGate': { describe: async () => ({ enabled: false }) },
    './line': { tokenSummary: () => ({}) }, './mailer': { describe: () => ({ configured: true }) },
    './reconcileMailSweep': { isEnabled: () => false }, './objectStorage': { driverName: 'replit' },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Date, setTimeout, clearTimeout,
    process: { env: { NODE_ENV: 'production', RAGIC_WEBHOOK_SECRET: 'fake' }, uptime: () => 0 },
    require(id) { assert.ok(Object.hasOwn(dependencies, id), `未替換依賴：${id}`); return dependencies[id]; },
  }, { filename });
  return module.exports;
}

const collect = (db) => drilldown().collectEvidence(NOW, { db, withTimeout: async (promise) => promise, timeoutMs: 5000 });
const row = (extra = {}) => ({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', at: LAST,
  error_code: 'RAGIC_TIMEOUT', last_error_code: 'RAGIC_TIMEOUT', status: 401, http_status: 400, ...extra });

test('errors 新增正確管線且保留既有 fingerprint', async () => {
  const db = { async query({ text }) {
    return { rows: /FROM line_push_log\b/.test(text)
      ? [{ http_status: 400, count: 3, first_seen: FIRST, last_seen: LAST }] : [] };
  } };
  const report = await health.buildErrorsReport(NOW, new Date(FIRST), {
    db, ring: health.createErrorRing({ startedAt: new Date(FIRST) }), build: 'test-build', env: 'production',
  });
  assert.equal(report.errors[0].pipeline, 'line.push');
  assert.ok(rules.PIPELINES.some((p) => p.id === report.errors[0].pipeline));
  assert.equal(report.errors[0].fingerprint, crypto.createHash('sha1')
    .update('line_push_log\nline_push_log\n400').digest('hex').slice(0, 12));
});

test('沒有失敗且全部正常：新欄位全省略，頂層及逐管線鍵集合與舊報告完全相同', async () => {
  const service = signalsService(fakeDb());
  const old = rules.assembleReport(await service.collectSignals(NOW));
  const report = await service.buildHealthReport(NOW);
  assert.equal(old.overall, 'green');
  assert.deepEqual(JSON.parse(JSON.stringify(report)), JSON.parse(JSON.stringify(old)));
  assert.deepEqual(Object.keys(report).sort(), ['system', 'build', 'checkedAt', 'overall', 'pipelines'].sort());
  for (const pipeline of report.pipelines) assert.deepEqual(Object.keys(pipeline).sort(),
    ['id', 'name', 'level', 'reason', 'lastSuccessAt', 'lastFailureAt', 'source'].sort());
  const empty = await health.buildErrorsReport(NOW, new Date(FIRST), {
    db: { query: async () => ({ rows: [] }) }, ring: health.createErrorRing(), build: 'test-build',
  });
  assert.deepEqual(empty.errors, []);
  assert.deepEqual(Object.keys(empty).sort(), ['system', 'build', 'checkedAt', 'since', 'retainedSince', 'truncated', 'errors'].sort());
});

test('真收集器接上所有證據來源，七日內最多五筆、新到舊，時區與 requestId 合規', async () => {
  const ids = ['RUN-1', 'bad@example.invalid', 'a'.repeat(65), '', 'RUN-5', 'RUN-6'];
  const db = fakeDb(() => [...ids.map((id, i) => row({ id, at: new Date(NOW - (i + 1) * 1000) })),
    row({ id: 'OLD', at: new Date(NOW - 7 * DAY - 1) }), row({ id: 'FUTURE', at: new Date(+NOW + 1) })].reverse());
  const report = await signalsService(db).buildHealthReport(NOW);
  const expected = [...rules.DAILY_JOBS, ...rules.INTERVAL_JOBS].map((job) => `job.${job.name}`)
    .concat(['ragic.outbox', 'ragic.webhook', 'line.push', 'mail.reconcile']);
  assert.deepEqual(report.pipelines.filter((p) => p.evidence).map((p) => p.id).sort(), expected.sort());
  for (const id of expected) {
    const items = byId(report, id).evidence;
    assert.equal(items.length, 5, id);
    for (const [i, item] of items.entries()) {
      assert.deepEqual(Object.keys(item).sort(), ['at', 'requestId', 'code', 'route', 'summary'].sort());
      assert.match(item.at, /\+08:00$/);
      assert.ok(new Date(item.at) <= NOW && new Date(item.at) >= NOW - 7 * DAY);
      if (i) assert.ok(new Date(items[i - 1].at) >= new Date(item.at));
      if (item.requestId !== null) assert.match(item.requestId, /^[A-Za-z0-9-]{1,64}$/);
    }
  }
  assert.deepEqual(byId(report, 'job.ragic_pull').evidence.map((item) => item.requestId), ['RUN-1', null, null, null, 'RUN-5']);
  assert.ok(byId(report, 'line.push').evidence.every((item) => item.requestId === null));
  assert.equal(byId(report, 'line.push').evidence[0].code, '400');
});

test('SQL 全為限時參數化唯讀、LIMIT 5、七日範圍及必要欄位，排程兩種名稱均含且只取 error', async () => {
  const db = fakeDb();
  await collect(db);
  assert.equal(db.calls.length, rules.DAILY_JOBS.length + rules.INTERVAL_JOBS.length + 6);
  for (const call of db.calls) {
    assert.match(call.text.trim(), /^SELECT\b/);
    assert.match(call.text, /ORDER BY[\s\S]+DESC[\s\S]+LIMIT 5$/);
    assert.match(call.text, />= \$1[\s\S]+<= \$2/);
    assert.equal(call.query_timeout, 5000);
    assert.equal(+call.values[0], NOW - 7 * DAY);
    assert.equal(+call.values[1], +NOW);
    assert.doesNotMatch(call.text, /SELECT\s+\*|recipient|email|line_uid|local_id|ragic_record_id|payload|message/i);
    if (/FROM job_runs/.test(call.text)) {
      assert.match(call.text, /status = 'error'/);
      assert.deepEqual(call.values[2], [call.values[2][0], `slot:${call.values[2][0]}`]);
    }
  }
  const sql = (table) => db.calls.find((call) => call.text.includes(`FROM ${table}`)).text;
  assert.match(sql('ragic_sync_failures'), /job_name = 'backup'/);
  assert.match(sql('ragic_sync_outbox'), /state LIKE 'blocked%' OR state IN \('retryable', 'failed'\)/);
  assert.match(sql('ragic_webhook_inbox'), /state = 'blocked'/);
  assert.doesNotMatch(sql('ragic_webhook_inbox'), /\bid\b/);
  assert.match(sql('ragic_webhook_attempts'), /status < 200 OR status >= 300/);
  for (const table of ['line_push_log', 'mail_outbox']) assert.match(sql(table), /status = 'failed'/);
});

test('所有 evidence 查詢並行啟動', async () => {
  const pending = [];
  const db = { query: () => new Promise((resolve) => pending.push(resolve)) };
  const result = collect(db);
  await new Promise(setImmediate);
  assert.equal(pending.length, rules.DAILY_JOBS.length + rules.INTERVAL_JOBS.length + 6);
  pending.forEach((resolve) => resolve({ rows: [] }));
  await result;
});

test('Ragic 拒收與排程、webhook 的雙來源均合併排序後只留最近五筆', async () => {
  const db = fakeDb((text) => /FROM ragic_sync_failures|FROM ragic_webhook_attempts/.test(text)
    ? [row({ at: new Date(NOW - 1000) }), row({ at: new Date(NOW - 3000) }), row({ at: new Date(NOW - 5000) })]
    : [row({ at: new Date(NOW - 2000) }), row({ at: new Date(NOW - 4000) }), row({ at: new Date(NOW - 6000) })]);
  const result = await collect(db);
  for (const id of ['job.ragic_backup', 'ragic.webhook']) {
    assert.equal(result[id].length, 5);
    assert.deepEqual(result[id].map((e) => +new Date(e.at)), [1, 2, 3, 4, 5].map((n) => NOW - n * 1000));
    assert.equal(new Set(result[id].map((e) => e.route)).size, 2);
  }
  assert.equal(result['job.ragic_backup'][0].summary, 'Ragic 拒收');
});

test('links 使用固定自家 HTTPS 網域、無 query 或凍結頁，且只用有效管線', () => {
  const { ADMIN_HOSTNAME, LINKS, addDrilldown } = drilldown();
  assert.equal(ADMIN_HOSTNAME, 'daos-tutoring-courses.replit.app');
  assert.ok(Object.keys(LINKS).length > 0);
  const report = { pipelines: rules.PIPELINES.map((p) => ({ id: p.id, level: 'yellow' })) };
  const linked = addDrilldown(report, {});
  for (const [id, links] of Object.entries(LINKS)) {
    assert.ok(rules.PIPELINES.some((p) => p.id === id));
    assert.deepEqual(byId(linked, id).links, links);
    assert.ok(links.length >= 1 && links.length <= 3);
    for (const link of links) {
      assert.deepEqual(Object.keys(link).sort(), ['label', 'url']);
      const url = new URL(link.url);
      assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, ADMIN_HOSTNAME);
      assert.equal(url.search, ''); assert.ok(!link.url.includes('?'));
      assert.equal(url.username, ''); assert.equal(url.password, '');
      assert.match(url.pathname, /^\/admin\/[a-z0-9-]+$/);
      assert.doesNotMatch(url.pathname, /manual-enroll|manual-deduction/);
    }
  }
});

test('虛構個資塞入原文、代碼與 payload，完整 pipelines／errors JSON 都不外露', async () => {
  const privateValues = ['fake-parent@example.invalid', '0912345678', 'Uabcdefabcdefabcdefabcdefabcdefab',
    '虛構王小明', 'A123456789', '98765432109876543210'];
  for (const value of privateValues) {
    const bad = row({ error_message: value, error_code: value, last_error_code: value, payload: { value },
      message: value, local_id: value, ragic_record_id: value });
    const report = await signalsService(fakeDb(() => [bad])).buildHealthReport(NOW);
    const db = { query: async () => ({ rows: [{ ...bad, job_name: value, error_kind: value,
      state: value, http_status: value, count: 1, first_seen: FIRST, last_seen: LAST }] }) };
    const errors = await health.buildErrorsReport(NOW, new Date(FIRST), {
      db, ring: health.createErrorRing(), build: 'test-build',
    });
    const output = JSON.stringify({ report, errors });
    for (const secret of privateValues) assert.ok(!output.includes(secret), secret);
  }
});

test('errors 來源對應完整、所有非 null 目標存在，未知／共用鎖／HTTP 為 null，fingerprint 全不變', async () => {
  const base = { count: 1, first_seen: FIRST, last_seen: LAST };
  const rows = {
    job_runs: [...rules.DAILY_JOBS.flatMap((job) => [job.name, `slot:${job.name}`]),
      ...rules.INTERVAL_JOBS.map((job) => job.name), 'ragic_sync', 'other'].map((job_name) => ({ ...base, job_name })),
    line_push_log: [{ ...base, http_status: 400 }], mail_outbox: [base],
    ragic_sync_failures: [{ ...base, error_code: 'RAGIC_TIMEOUT', error_kind: 'transient' }],
    ragic_sync_outbox: [{ ...base, state: 'failed', last_error_code: 'RAGIC_TIMEOUT' }],
    ragic_webhook_inbox: [{ ...base, last_error_code: 'WEBHOOK_BLOCKED' }],
  };
  const ring = health.createErrorRing();
  const res = new EventEmitter(); res.statusCode = 500;
  ring.middleware({ method: 'GET', originalUrl: '/api/fake/:id', route: { path: '/api/fake/:id' } }, res, () => {});
  res.emit('finish');
  const report = await health.buildErrorsReport(new Date(), new Date(FIRST), {
    db: { query: async ({ text }) => ({ rows: rows[Object.keys(rows).find((name) => text.includes(`FROM ${name} `))] || [] }) },
    ring, build: 'test-build',
  });
  const ids = new Set(rules.PIPELINES.map((p) => p.id));
  for (const target of Object.values(rules.ERROR_PIPELINES)) assert.ok(ids.has(target), target);
  assert.equal(report.errors.length, rows.job_runs.length + 6);
  for (const error of report.errors) {
    const fixed = { line_push_log: 'line.push', mail_outbox: 'mail.reconcile',
      ragic_sync_failures: 'job.ragic_backup', ragic_sync_outbox: 'ragic.outbox', ragic_webhook_inbox: 'ragic.webhook' };
    const jobName = error.route.startsWith('job_runs/') ? error.route.slice(9).replace(/^slot:/, '') : '';
    const expected = jobName && ids.has(`job.${jobName}`) ? `job.${jobName}` : fixed[error.route] || null;
    assert.equal(error.pipeline, expected);
    if (error.pipeline !== null) assert.ok(ids.has(error.pipeline));
    const source = error.route.startsWith('job_runs/') ? 'job_runs' : error.route.startsWith('GET ') ? 'http' : error.route;
    assert.equal(error.fingerprint, crypto.createHash('sha1').update([source, error.route, error.code].join('\n')).digest('hex').slice(0, 12));
  }
  for (const route of ['job_runs/ragic_sync', 'job_runs/other', 'GET /api/fake/:id']) {
    assert.equal(report.errors.find((e) => e.route === route).pipeline, null);
  }
});

test('某來源拋錯時整條對應管線省略 evidence，其餘管線仍保留', async () => {
  for (const table of ['ragic_sync_failures', 'ragic_webhook_inbox']) {
    const result = await collect(fakeDb((text) => {
      if (new RegExp(`FROM ${table}\\b`).test(text)) throw new Error('虛構錯誤');
      return [row()];
    }));
    assert.equal(result[table === 'ragic_sync_failures' ? 'job.ragic_backup' : 'ragic.webhook'], undefined);
    assert.equal(result['line.push'].length, 1);
  }
});

test('真 API：evidence 讀取失敗仍 200／no-store、燈號與 reason 不變、其他證據保留及 Host 不影響 links', async (t) => {
  const express = require('../server/node_modules/express');
  const db = fakeDb((text) => {
    if (/FROM line_push_log\b/.test(text)) throw new Error('虛構錯誤');
    return [row()];
  });
  const service = signalsService(db);
  const signalsPath = require.resolve('../server/services/healthSignals');
  const dbPath = require.resolve('../server/models/db');
  require.cache[signalsPath] = { id: signalsPath, filename: signalsPath, loaded: true, exports: service };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: db } };
  const app = express(); app.use('/api/health', require('../server/routes/health'));
  const original = process.env.HEALTH_TOKEN; process.env.HEALTH_TOKEN = 'drilldown-test';
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => srv.once('listening', resolve));
  t.after(async () => {
    if (original === undefined) delete process.env.HEALTH_TOKEN; else process.env.HEALTH_TOKEN = original;
    await new Promise((resolve) => srv.close(resolve));
  });
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/health/pipelines`, {
    headers: { Authorization: 'Bearer drilldown-test', Host: 'fake.example.invalid' },
  });
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  const report = await res.json();
  const old = rules.assembleReport(await service.collectSignals(new Date(report.checkedAt)));
  assert.equal(report.overall, old.overall);
  for (const p of report.pipelines) {
    const { evidence, links, ...existing } = p;
    assert.deepEqual(existing, byId(old, p.id));
  }
  assert.ok(!Object.hasOwn(byId(report, 'line.push'), 'evidence'));
  assert.equal(byId(report, 'mail.reconcile').evidence.length, 1);
  assert.ok(JSON.stringify(report).includes('https://daos-tutoring-courses.replit.app/admin/'));
  assert.ok(!JSON.stringify(report).includes('fake.example.invalid'));
});

test('真收集器沿用五秒 timeout，卡住的 evidence 不改燈號且省略欄位', async () => {
  const db = fakeDb((text) => /FROM line_push_log\b/.test(text) ? new Promise(() => {}) : []);
  const service = signalsService(db);
  const old = rules.assembleReport(await service.collectSignals(NOW));
  const started = Date.now();
  const report = await service.buildHealthReport(NOW);
  assert.ok(Date.now() - started < 8000);
  assert.ok(!Object.hasOwn(byId(report, 'line.push'), 'evidence'));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), JSON.parse(JSON.stringify(old)));
});
