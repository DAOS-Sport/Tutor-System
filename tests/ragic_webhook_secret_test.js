'use strict';
// Ragic webhook 金鑰比對（#38）：改成固定時間比對後，對外結果與改前完全相同；
// 網址帶 secret 仍然接受（Ragic 後台不一定能改用 header）。ragicAdmin 以 stub 取代，不連 DB。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const express = require(path.join(SERVER, 'node_modules/express'));

const SECRET = 'fixture-secret-000000000000000000';
function stub(rel, exportsObj) {
  const file = require.resolve(path.join(SERVER, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
stub('services/ragicAdmin.js', { async handleRagicWebhook() { return { ok: true, count: 1 }; } });
stub('services/ragicWebhookAttempts.js', { record() {} });
const router = require(path.join(SERVER, 'routes/ragicWebhook.js'));

const app = express();
app.use('/hook', router);

function post(port, { query = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hook/Z01' + query,
      headers: { 'content-type': 'text/plain', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end('[6793]');
  });
}

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok   ' + label); } catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const env = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    process.env.RAGIC_WEBHOOK_SECRET = SECRET;
    const cases = [
      ['header X-Ragic-Webhook-Secret 正確', { headers: { 'X-Ragic-Webhook-Secret': SECRET } }, 200],
      ['header X-Webhook-Secret 正確', { headers: { 'X-Webhook-Secret': SECRET } }, 200],
      ['網址 ?secret= 正確（仍然接受）', { query: `?secret=${encodeURIComponent(SECRET)}` }, 200],
      ['secret 前後有空白（照舊 trim）', { headers: { 'X-Webhook-Secret': `  ${SECRET} ` } }, 200],
      ['錯誤 secret', { query: '?secret=wrong-secret' }, 401],
      ['長度較短', { query: `?secret=${SECRET.slice(0, -1)}` }, 401],
      ['長度較長', { query: `?secret=${SECRET}x` }, 401],
      ['同長度、最後一碼不同', { query: `?secret=${SECRET.slice(0, -1)}1` }, 401],
      ['沒帶 secret', {}, 401],
    ];
    for (const [label, opts, want] of cases) {
      await check(label + ` → ${want}`, async () => assert.equal(await post(port, opts), want));
    }

    delete process.env.RAGIC_WEBHOOK_SECRET;
    await check('正式環境沒設 secret → 401', async () => assert.equal(await post(port, { query: '?secret=anything' }), 401));
    process.env.NODE_ENV = 'development';
    await check('開發環境沒設 secret → 放行（與改前相同）', async () => assert.equal(await post(port), 200));
  } finally {
    process.env = env;
    server.close();
  }

  await check('錯誤 log 會遮掉網址裡的 secret', async () => {
    const src = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
    const line = src.split('\n').find((l) => l.includes("console.error('[unhandled]'"));
    assert.ok(line && !/req\.originalUrl,/.test(line), '[unhandled] log 直接印 originalUrl');
    const redact = (u) => String(u || '').replace(/([?&]secret=)[^&]+/gi, '$1***');
    assert.ok(line.includes(".replace(/([?&]secret=)[^&]+/gi, '$1***')"), '遮罩規則與預期不同');
    assert.equal(redact('/api/ragic-webhook/Z01?secret=abc&x=1'), '/api/ragic-webhook/Z01?secret=***&x=1');
    assert.equal(redact('/api/x?a=1&SECRET=abc'), '/api/x?a=1&SECRET=***');
    assert.equal(redact('/api/x?a=1'), '/api/x?a=1');
  });

  if (failures) { console.error(`ragic_webhook_secret_test: ${failures} FAIL`); process.exit(1); }
  console.log('PASS Ragic webhook：固定時間比對，header／網址 secret 結果與改前相同，錯誤 log 不印 secret');
})();
