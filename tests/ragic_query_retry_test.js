// docs/ragic_sync_audit.md 決策4 / quick win 追加：query() 的重試/退避 + 錯誤分類。
// 策略同 tests/perf/ragic_concurrency.js：monkeypatch ragic.js 內部的 axios.get，
// 讓 stub 依呼叫次數丟出可控的錯誤或成功，驗證：
//   1. 可重試錯誤（逾時/5xx/429/網路層）真的會重試，且最終成功後不再多重試。
//   2. 不可重試錯誤（401/404/其餘 4xx）第一次失敗就直接拋出，不浪費重試。
//   3. 重試次數用盡後，錯誤改標 RAGIC_RETRY_EXHAUSTED，且 retryCount 正確。
// 用極小的 backoff（RAGIC_QUERY_RETRY_BASE_MS=5）讓測試維持毫秒級。
const assert = require('assert');
const Module = require('module');

process.env.RAGIC_QUERY_RETRY_BASE_MS = '5';
process.env.RAGIC_QUERY_MAX_RETRIES = '3';
process.env.RAGIC_BASE_URL = process.env.RAGIC_BASE_URL || 'http://stub';
process.env.RAGIC_API_KEY = process.env.RAGIC_API_KEY || 'stub';
process.env.RAGIC_FORM_H01 = process.env.RAGIC_FORM_H01 || '/h01';

let callCount = 0;
let behavior = null; // function(callIndex) -> {throw: err} | {resolve: data}

const origLoad = Module._load;
Module._load = function (req, parent) {
  if (req === 'axios' && parent && parent.id && parent.id.endsWith('services/ragic.js')) {
    return {
      create: () => ({
        get: async () => {
          callCount += 1;
          const outcome = behavior(callCount);
          if (outcome.throw) throw outcome.throw;
          return { data: outcome.resolve };
        },
      }),
    };
  }
  return origLoad.apply(this, arguments);
};
delete require.cache[require.resolve('../server/services/ragic')];
const ragic = require('../server/services/ragic');

function timeoutError() {
  const e = new Error('timeout of 60000ms exceeded');
  e.code = 'ECONNABORTED';
  return e;
}

function httpError(status, msg = 'boom') {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: { msg } };
  return e;
}

async function testRetriesTransientErrorThenSucceeds() {
  callCount = 0;
  behavior = (i) => (i < 3 ? { throw: timeoutError() } : { resolve: { count: 1 } });
  const result = await ragic.probeForm('/h01', {});
  assert.strictEqual(callCount, 3, `expected 3 total attempts (2 retries + success), got ${callCount}`);
  assert.strictEqual(result.ok, true);
}

async function testNonRetryableFailsImmediately() {
  callCount = 0;
  behavior = () => ({ throw: httpError(401, '未授權') });
  let caught = null;
  try {
    await ragic.probeForm('/h01', {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected probeForm to throw');
  assert.strictEqual(callCount, 1, 'a 401 must not be retried');
  assert.strictEqual(caught.code, 'RAGIC_AUTH_FAILED');
  assert.strictEqual(caught.retryCount, 0);
}

async function testRetryExhaustionReportsCorrectCode() {
  callCount = 0;
  behavior = () => ({ throw: httpError(503, '服務暫時無法使用') });
  let caught = null;
  try {
    await ragic.probeForm('/h01', {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected probeForm to throw after exhausting retries');
  // maxRetries=3 → 1 initial attempt + 3 retries = 4 total calls
  assert.strictEqual(callCount, 4);
  assert.strictEqual(caught.code, 'RAGIC_RETRY_EXHAUSTED');
  assert.strictEqual(caught.retryCount, 3);
  assert.strictEqual(caught.cause.code, 'RAGIC_HTTP_SERVER_ERROR');
}

async function test404NotRetried() {
  callCount = 0;
  behavior = () => ({ throw: httpError(404, '找不到') });
  let caught = null;
  try {
    await ragic.probeForm('/h01', {});
  } catch (err) {
    caught = err;
  }
  assert.strictEqual(callCount, 1);
  assert.strictEqual(caught.code, 'RAGIC_ENDPOINT_NOT_FOUND');
}

async function testRateLimitIsRetried() {
  callCount = 0;
  behavior = (i) => (i < 2 ? { throw: httpError(429, '頻率過高') } : { resolve: { count: 1 } });
  const result = await ragic.probeForm('/h01', {});
  assert.strictEqual(callCount, 2);
  assert.strictEqual(result.ok, true);
}

(async () => {
  await testRetriesTransientErrorThenSucceeds();
  await testNonRetryableFailsImmediately();
  await testRetryExhaustionReportsCorrectCode();
  await test404NotRetried();
  await testRateLimitIsRetried();
  console.log('ragic_query_retry_test: PASS');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
