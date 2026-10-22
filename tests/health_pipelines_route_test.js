'use strict';
/**
 * GET /api/health/pipelines 的門：沒設 HEALTH_TOKEN 回 503、token 不對回 401、對了回 200，
 * 每一種回應都不給快取。報告內容用假的收集器，不連 DB；另用會丟錯的假 pool 跑真的收集器，
 * 確認讀不到資料時報告照樣產出、只是對應管線變紅。
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const express = require(path.join(SERVER, 'node_modules/express'));
const { contractProblems } = require('./fixtures/health_contract');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

console.log('health_pipelines_route_test');

const STUB_REPORT = { system: 'daos-tutoring', build: 't', checkedAt: '2026-10-22T00:00:00.000Z', overall: 'green',
  pipelines: [{ id: 'database', name: '資料庫', level: 'green', reason: 'ok', lastSuccessAt: null, lastFailureAt: null, source: null }] };
let calls = 0;
let behavior = async () => STUB_REPORT;
const signalsPath = require.resolve(path.join(SERVER, 'services/healthSignals'));
require.cache[signalsPath] = { id: signalsPath, filename: signalsPath, loaded: true,
  exports: { buildHealthReport: async (now) => { calls += 1; assert.ok(now instanceof Date); return behavior(); } } };
const router = require(path.join(SERVER, 'routes/health'));

async function withApp(fn) {
  const app = express();
  app.use('/api/health', router);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}/api/health/pipelines`); }
  finally { await new Promise((r) => srv.close(r)); }
}

function setToken(v) {
  if (v === undefined) delete process.env.HEALTH_TOKEN; else process.env.HEALTH_TOKEN = v;
}

(async () => {
  const original = process.env.HEALTH_TOKEN;
  await withApp(async (url) => {
    await check('沒設 HEALTH_TOKEN → 503，不產生報告，不給快取', async () => {
      calls = 0;
      for (const v of [undefined, '', '   ']) {
        setToken(v);
        const res = await fetch(url, { headers: { Authorization: 'Bearer anything' } });
        assert.strictEqual(res.status, 503, `HEALTH_TOKEN=${JSON.stringify(v)}`);
        assert.strictEqual(res.headers.get('cache-control'), 'no-store');
      }
      assert.strictEqual(calls, 0);
    });

    await check('token 缺少、錯誤、長度不同、沒有 Bearer 前綴 → 401，不產生報告，不給快取', async () => {
      setToken('right-token');
      calls = 0;
      const cases = [{}, { Authorization: 'Bearer wrong-token' }, { Authorization: 'Bearer right-token-x' },
        { Authorization: 'right-token' }, { Authorization: 'bearer right-token' }, { Authorization: 'Bearer ' }];
      for (const headers of cases) {
        const res = await fetch(url, { headers });
        assert.strictEqual(res.status, 401, JSON.stringify(headers));
        assert.strictEqual(res.headers.get('cache-control'), 'no-store');
      }
      assert.strictEqual(calls, 0);
    });

    await check('token 正確 → 200、回報告、不給快取', async () => {
      setToken('right-token');
      calls = 0;
      behavior = async () => STUB_REPORT;
      const res = await fetch(url, { headers: { Authorization: 'Bearer right-token' } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('cache-control'), 'no-store');
      assert.deepStrictEqual(await res.json(), STUB_REPORT);
      assert.strictEqual(calls, 1);
    });

    await check('Secrets 值前後有空白時照樣比對（只修剪設定值，不修剪送來的 token）', async () => {
      setToken('right-token\n');
      assert.strictEqual((await fetch(url, { headers: { Authorization: 'Bearer right-token' } })).status, 200);
      assert.strictEqual((await fetch(url, { headers: { Authorization: 'Bearer  right-token' } })).status, 401);
    });

    await check('產生報告時丟錯 → 500，不回成功、不給快取', async () => {
      setToken('right-token');
      behavior = async () => { throw new Error('boom'); };
      const res = await fetch(url, { headers: { Authorization: 'Bearer right-token' } });
      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.headers.get('cache-control'), 'no-store');
      assert.ok(!JSON.stringify(await res.json()).includes('boom'), '錯誤原文不外露');
    });
  });
  setToken(original);

  await check('routeRegistry 把 /api/health 掛到 routes/health', async () => {
    const { API_ROUTES } = require(path.join(SERVER, 'routeRegistry'));
    const entry = API_ROUTES.find(([prefix]) => prefix === '/api/health');
    assert.ok(entry, '清冊裡沒有 /api/health');
    assert.ok(/require\('\.\/routes\/health'\)/.test(entry[1].toString()));
  });

  await check('真的收集器：資料庫全部讀不到時仍產出合格報告，讀 DB 的管線都紅、上傳儲存不受影響', async () => {
    delete require.cache[signalsPath];
    const { collectSignals } = require(signalsPath);
    const rules = require(path.join(SERVER, 'services/healthRules'));
    const brokenDb = { query: async () => { throw new Error('connection refused'); } };
    const now = new Date('2026-10-22T02:00:00Z');
    const report = rules.assembleReport(await collectSignals(now, { db: brokenDb }));
    assert.deepStrictEqual(contractProblems(report), []);
    assert.strictEqual(report.overall, 'red');
    const byId = Object.fromEntries(report.pipelines.map((p) => [p.id, p]));
    for (const id of ['database', 'job.ragic_backup', 'ragic.outbox', 'ragic.webhook', 'line.push', 'mail.reconcile', 'course-type.schedule', 'chat.rooms']) {
      assert.strictEqual(byId[id].level, 'red', `${id}: ${byId[id].reason}`);
    }
    assert.ok(/connection refused/.test(byId.database.reason), byId.database.reason);
    assert.notStrictEqual(byId['storage.uploads'].reason, undefined);
  });

  await check('真的收集器：查詢卡住時 5 秒內放棄，只讓那條管線變紅', async () => {
    const { collectSignals } = require(signalsPath);
    const rules = require(path.join(SERVER, 'services/healthRules'));
    const hangingDb = { query: async (sql) => (/^SELECT 1$/.test(String(sql)) ? { rows: [{}] } : new Promise(() => {})) };
    const t0 = Date.now();
    const report = rules.assembleReport(await collectSignals(new Date(), { db: hangingDb }));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 8000, `花了 ${elapsed} ms`);
    const byId = Object.fromEntries(report.pipelines.map((p) => [p.id, p]));
    assert.strictEqual(byId.database.level, 'green', byId.database.reason);
    assert.strictEqual(byId['mail.reconcile'].level, 'red');
    assert.ok(/秒沒有回應/.test(byId['mail.reconcile'].reason), byId['mail.reconcile'].reason);
  });

  if (failed) console.error('\nhealth_pipelines_route_test: ' + failed + ' FAILED');
  else console.log('\nhealth_pipelines_route_test: ALL PASS');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
