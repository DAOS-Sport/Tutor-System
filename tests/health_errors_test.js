'use strict';
// 全部使用虛構資料與假的 db.query；HTTP 僅監聽本機隨機埠。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const health = require('../server/services/healthErrors');
const NOW = new Date('2026-11-11T08:00:00Z');
const FIRST = '2026-11-11T06:00:00Z';
const LAST = '2026-11-11T07:00:00Z';
const TOP_KEYS = ['system', 'build', 'checkedAt', 'since', 'retainedSince', 'truncated', 'errors'].sort();
const ERROR_KEYS = ['system', 'env', 'ts', 'level', 'code', 'message', 'request_id', 'route',
  'fingerprint', 'count', 'first_seen', 'last_seen', 'release', 'pipeline'].sort();

function fakeDb(rows = {}) {
  const calls = [];
  return { calls, async query(sql, args) {
    if (typeof sql === 'object') { args = sql.values; sql = sql.text; }
    calls.push({ sql, args });
    assert.match(sql.trim(), /^(SELECT|WITH)\b/);
    const table = Object.keys(rows).find((t) => new RegExp(`FROM ${t}\\b`).test(sql));
    return { rows: table ? rows[table] : [] };
  } };
}
function options(extra = {}) {
  return { db: fakeDb(), ring: health.createErrorRing({ startedAt: new Date(FIRST) }),
    build: 'test-build', env: 'production', ...extra };
}
function request(ring, { status = 500, baseUrl = '/api/orders', route = '/:id/refund', url = '/api/orders/123/refund?email=hidden@example.invalid', error } = {}) {
  const req = { method: 'POST', baseUrl, route: route === null ? undefined : { path: route }, originalUrl: url,
    headers: { 'x-request-id': '0912345678', authorization: 'Bearer private' }, body: { name: '虛構家長' } };
  const res = new EventEmitter();
  res.statusCode = status;
  ring.middleware(req, res, () => {});
  if (error) ring.captureError(error, req, res);
  res.emit('finish');
  return { req, res };
}

test('since 預設 24 小時，過早夾到 7 天，保留有效時區', () => {
  assert.equal(health.parseSince(undefined, NOW).toISOString(), '2026-11-10T08:00:00.000Z');
  assert.equal(health.parseSince('2020-01-01T00:00:00+08:00', NOW).toISOString(), '2026-11-04T08:00:00.000Z');
  assert.equal(health.parseSince('2026-11-11T15:00:00+08:00', NOW).toISOString(), LAST.replace('Z', '.000Z'));
});
test('since 拒絕無時區、壞日期、空值、陣列及物件', () => {
  for (const value of ['', 'bad', '2026-11-11', '2026-11-11T07:00:00', '2026-02-30T00:00:00Z',
    '2026-11-11T25:00:00Z', '2026-11-11T07:00:00+25:00', ['2026-11-11T07:00:00Z'], {}]) {
    assert.throws(() => health.parseSince(value, NOW), /INVALID_HEALTH_SINCE/);
  }
});
test('errors-v1 頂層與事件鍵集合、時區、release 與 fingerprint', async () => {
  const db = fakeDb({ line_push_log: [{ http_status: 400, count: 3, first_seen: FIRST, last_seen: LAST }] });
  const report = await health.buildErrorsReport(NOW, health.parseSince(undefined, NOW), options({ db }));
  assert.deepEqual(Object.keys(report).sort(), TOP_KEYS);
  assert.equal(report.system, 'daos-tutoring');
  assert.equal(report.truncated, false);
  assert.equal(report.errors.length, 1);
  const e = report.errors[0];
  assert.deepEqual(Object.keys(e).sort(), ERROR_KEYS);
  assert.equal(e.release, report.build);
  assert.equal(e.env, 'production');
  assert.match(e.ts, /\+08:00$/);
  assert.equal(e.ts, e.last_seen);
  assert.equal(e.count, 3);
  assert.equal(e.request_id, null);
  assert.equal(e.fingerprint, crypto.createHash('sha1').update(['line_push_log', e.route, e.code].join('\n')).digest('hex').slice(0, 12));
});
test('六張已定義失敗表使用參數化唯讀彙整，排除 skipped_lock／成功', async () => {
  const db = fakeDb();
  const since = health.parseSince(undefined, NOW);
  await health.buildErrorsReport(NOW, since, options({ db }));
  assert.equal(db.calls.length, 6);
  for (const { sql, args } of db.calls) {
    assert.deepEqual(args, [since, NOW]);
    assert.match(sql, /COUNT\(\*\)/i);
    assert.match(sql, /\$1/);
    assert.match(sql, /\$2/);
    assert.doesNotMatch(sql, /SELECT\s+\*|recipient|local_id|ragic_record_id|payload|sanitized_error/i);
  }
  assert.match(db.calls.find((x) => /FROM job_runs\b/.test(x.sql)).sql, /status = 'error'/);
  assert.match(db.calls.find((x) => /FROM mail_outbox\b/.test(x.sql)).sql, /status = 'failed'/);
  assert.match(db.calls.find((x) => /FROM ragic_sync_outbox\b/.test(x.sql)).sql, /retryable/);
});
test('DB 來源不輸出 UID／Email／姓名／電話／記錄 ID 或原始 message', async () => {
  const privateData = { recipient_uid: 'Uabcdefabcdefabcdefabcdefabcdefab', recipient: 'parent@example.invalid',
    local_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ragic_record_id: '7654321098', name: '虛構家長甲',
    message: '虛構學員乙 0912345678 parent@example.invalid', reason: '虛構學員乙 parent@example.invalid',
    sanitized_error: '虛構學員乙' };
  const base = { ...privateData, count: 1, first_seen: FIRST, last_seen: LAST };
  const db = fakeDb({ job_runs: [{ ...base, job_name: 'line_bot_webhook', error_message: '操作中止' }],
    line_push_log: [{ ...base, http_status: 400 }], ragic_sync_failures: [{ ...base, error_code: 'RAGIC_VALIDATION_ERROR', error_kind: 'permanent' }],
    mail_outbox: [base], ragic_webhook_inbox: [{ ...base, last_error_code: 'RAGIC_WEBHOOK_FAILED' }],
    ragic_sync_outbox: [{ ...base, state: 'blocked_data_conflict', last_error_code: 'RAGIC_UID_DUPLICATE' }] });
  const report = await health.buildErrorsReport(NOW, health.parseSince(undefined, NOW), options({ db }));
  assert.equal(report.errors.length, 6);
  const output = JSON.stringify(report);
  for (const value of Object.values(privateData)) assert.ok(!output.includes(value), value);
  for (const key of Object.keys(privateData).filter((key) => key !== 'message')) assert.ok(!output.includes(`"${key}":`), key);
});
test('job_runs 任意原文採固定句，不輸出個資且不超過 200 字', async () => {
  const db = fakeDb({ job_runs: [{ job_name: 'line_bot_webhook', count: 1, first_seen: FIRST, last_seen: LAST,
    error_message: 'parent@example.invalid 0912345678 A123456789 Uabcdefabcdefabcdefabcdefabcdefab ' + '錯'.repeat(250) }] });
  const e = (await health.buildErrorsReport(NOW, health.parseSince(undefined, NOW), options({ db }))).errors[0];
  assert.ok(e.message.length <= 200);
  assert.doesNotMatch(e.message, /parent@example|0912345678|123456789|Uabcdef/);
});
test('等級：job／webhook error；推播 4xx／永久驗證／outbox 衝突 warn', async () => {
  const base = { count: 1, first_seen: FIRST, last_seen: LAST };
  const db = fakeDb({ job_runs: [{ ...base, job_name: 'line_bot_webhook' }], line_push_log: [{ ...base, http_status: 400 }, { ...base, http_status: 500 }],
    ragic_sync_failures: [{ ...base, error_kind: 'permanent', error_code: 'RAGIC_VALIDATION_ERROR' }, { ...base, error_kind: 'transient', error_code: 'RAGIC_TIMEOUT' }],
    ragic_webhook_inbox: [{ ...base, last_error_code: 'RAGIC_WEBHOOK_FAILED' }],
    ragic_sync_outbox: [{ ...base, state: 'blocked_data_conflict' }, { ...base, state: 'blocked_retry_exhausted' }] });
  const errors = (await health.buildErrorsReport(NOW, health.parseSince(undefined, NOW), options({ db }))).errors;
  const level = (code) => errors.find((e) => e.code === code).level;
  assert.equal(level('400'), 'warn'); assert.equal(level('500'), 'error');
  assert.equal(level('RAGIC_VALIDATION_ERROR'), 'warn'); assert.equal(level('RAGIC_TIMEOUT'), 'error');
  assert.equal(level('RAGIC_WEBHOOK_FAILED'), 'error');
  assert.equal(level('blocked_data_conflict'), 'warn'); assert.equal(level('blocked_retry_exhausted'), 'error');
});
test('記憶體收 500 與直接 503，不收 4xx；無既有請求 ID 時為 null、不採外來 header', () => {
  const ring = health.createErrorRing({ startedAt: NOW });
  request(ring, { error: new TypeError('虛構家長 parent@example.invalid 0912345678') });
  request(ring, { status: 503 }); request(ring, { status: 400 });
  const events = ring.read(new Date(0));
  assert.equal(events.length, 2);
  assert.equal(events[0].route, 'POST /api/orders/:id/refund');
  assert.equal(events[0].level, 'error');
  assert.match(events[0].message, /TypeError/);
  assert.deepEqual(events.map((e) => e.request_id), [null, null]);
  assert.doesNotMatch(JSON.stringify(events), /虛構家長|parent@example|0912345678|private|email=/);
});
test('路由 fallback 遮數字段、UUID、Email、UID 且去 query', () => {
  const ring = health.createErrorRing();
  request(ring, { route: null, url: '/api/students/123/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?name=虛構家長', baseUrl: '' });
  assert.equal(ring.read(new Date(0))[0].route, 'POST /api/students/:id/:id');
  request(ring, { route: null, url: '/api/students/parent%40example.invalid/Uabcdefabcdefabcdefabcdefabcdefab', baseUrl: '' });
  assert.doesNotMatch(JSON.stringify(ring.read(new Date(0))), /parent|abcdef/);
});
test('環容量有上限；retainedSince 仍為程序啟動時間，讀取 since 不改動舊資料', () => {
  const ring = health.createErrorRing({ capacity: 2, startedAt: new Date(FIRST) });
  for (let i = 0; i < 3; i++) request(ring, { route: `/failure-${i}` });
  assert.equal(ring.read(new Date(0)).length, 2);
  assert.equal(ring.retainedSince.toISOString(), new Date(FIRST).toISOString());
  assert.equal(ring.read(new Date(Date.now() + 10000)).length, 0);
  assert.equal(ring.read(new Date(0)).length, 2);
});
test('同 fingerprint 合併計數、起訖與最後事件；環截斷會揭露 truncated', async () => {
  const ring = health.createErrorRing({ capacity: 2, startedAt: new Date(FIRST) });
  for (let i = 0; i < 3; i++) request(ring);
  const now = new Date();
  const report = await health.buildErrorsReport(now, new Date(0), options({ ring }));
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].count, 2);
  assert.equal(report.truncated, true);
});
test('排序後才取 200 個 fingerprint，剛好 200 不截斷', async () => {
  const rows = Array.from({ length: 201 }, (_, i) => ({ error_code: `TEST_CODE_${i}`, error_kind: 'unknown', count: 2,
    first_seen: FIRST, last_seen: new Date(new Date(FIRST).getTime() + i * 1000).toISOString() }));
  const db = fakeDb({ ragic_sync_failures: rows });
  const report = await health.buildErrorsReport(NOW, health.parseSince(undefined, NOW), options({ db }));
  assert.equal(report.errors.length, 200); assert.equal(report.truncated, true);
  assert.equal(report.errors[0].code, 'TEST_CODE_200'); assert.equal(report.errors.at(-1).code, 'TEST_CODE_1');
  rows.pop();
  assert.equal((await health.buildErrorsReport(NOW, health.parseSince(undefined, NOW), options({ db }))).truncated, false);
});
test('資料表讀取失敗向上回報，不假裝沒有錯誤', async () => {
  await assert.rejects(health.buildErrorsReport(NOW, new Date(FIRST), options({ db: { query: async () => { throw new Error('虛構讀取錯誤'); } } })), /虛構讀取錯誤/);
});

test('真 HTTP 路由：503／401／400／200、since 夾限、no-store 與失敗 500', async (t) => {
  const express = require(path.join(__dirname, '../server/node_modules/express'));
  const db = fakeDb();
  const dbPath = require.resolve('../server/models/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: db } };
  const signalsPath = require.resolve('../server/services/healthSignals');
  require.cache[signalsPath] = { id: signalsPath, filename: signalsPath, loaded: true, exports: { buildHealthReport: async () => ({}) } };
  const app = express();
  app.use(health.errorRing.middleware);
  app.use('/api/health', require('../server/routes/health'));
  const original = process.env.HEALTH_TOKEN;
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => srv.once('listening', resolve));
  t.after(async () => {
    if (original === undefined) delete process.env.HEALTH_TOKEN; else process.env.HEALTH_TOKEN = original;
    await new Promise((resolve) => srv.close(resolve));
  });
  const url = `http://127.0.0.1:${srv.address().port}/api/health/errors`;
  const get = (query = '', token) => fetch(url + query, { headers: token ? { Authorization: token } : {} });
  delete process.env.HEALTH_TOKEN;
  let res = await get(); assert.equal(res.status, 503); assert.equal(res.headers.get('cache-control'), 'no-store');
  process.env.HEALTH_TOKEN = 'health-test';
  for (const token of [undefined, 'Bearer wrong', 'health-test', 'Bearer a', 'Bearer health-test-extra']) {
    res = await get('', token); assert.equal(res.status, 401); assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(db.calls.length, 0);
  for (const query of ['?since=bad', '?since=', '?since=2026-02-30T00:00:00Z', '?since=2026-11-11T00:00:00Z&since=2026-11-11T01:00:00Z']) {
    res = await get(query, 'Bearer health-test'); assert.equal(res.status, 400); assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(db.calls.length, 0);
  res = await get('?since=2020-01-01T00:00:00Z', 'Bearer health-test');
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json(); assert.deepEqual(Object.keys(body).sort(), TOP_KEYS);
  assert.equal(new Date(body.checkedAt) - new Date(body.since), 7 * 86400000);
  db.query = async () => { throw new Error('parent@example.invalid'); };
  res = await get('', 'Bearer health-test'); assert.equal(res.status, 500);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(!(await res.text()).includes('parent@example.invalid'));
});
test('index 掛鉤在第一個路由之前，既有錯誤 handler 保留掛鉤', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  assert.ok(source.indexOf('app.use(errorRing.middleware)') < source.indexOf("app.use('/api/ragic-webhook'"));
  assert.match(source, /errorRing\.captureError\(err, req, res\)/);
});

test('真 Express 的直接 500、拋錯與掛載根路由，各留下完整樣板一筆', async (t) => {
  const express = require(path.join(__dirname, '../server/node_modules/express'));
  const ring = health.createErrorRing();
  const app = express();
  app.use(ring.middleware);
  const router = express.Router();
  router.get('/:token/direct', (req, res) => res.status(500).json({ error: '虛構失敗' }));
  router.get('/:token/throw', () => { throw new TypeError('虛構學員 parent@example.invalid'); });
  router.get('/', () => { throw new Error('虛構根路由失敗'); });
  app.use('/api/orders', router);
  app.use((err, req, res, next) => { ring.captureError(err, req, res); res.status(500).json({ error: '虛構失敗' }); });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => srv.once('listening', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const url = `http://127.0.0.1:${srv.address().port}/api/orders`;
  await fetch(`${url}/fake-opaque-token/direct?email=parent@example.invalid`);
  await fetch(`${url}/fake-opaque-token/throw?email=parent@example.invalid`);
  await fetch(`${url}/`);
  const events = ring.read(new Date(0));
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.route), ['GET /api/orders/:token/direct', 'GET /api/orders/:token/throw', 'GET /api/orders/']);
  assert.deepEqual(events.map((e) => e.request_id), [null, null, null]);
  assert.doesNotMatch(JSON.stringify(events), /fake-opaque-token|parent@example|虛構學員/);
});
