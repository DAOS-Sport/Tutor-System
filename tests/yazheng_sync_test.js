'use strict';
/**
 * 雅正轉同步（SPEC YZ-A2／YZ-A3）不連 DB 的部分：簽章、設定閘門、分頁游標、欄位白名單、
 * 對帳 API 的門（沒設金鑰 503、金鑰不對 401、對了 200、不給快取）。資料庫行為見 yazheng_sync_db_test.js。
 */
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const express = require(path.join(SERVER, 'node_modules/express'));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

console.log('yazheng_sync_test');

const svcPath = require.resolve(path.join(SERVER, 'services/yazhengSync'));
const real = require(svcPath);
let listCalls = [];
require.cache[svcPath].exports = {
  ...real,
  listOrders: async (args) => { listCalls.push(args); return { orders: [{ enrollment_id: 'e1' }], next: null }; },
};
const router = require(path.join(SERVER, 'routes/yazhengSync'));

async function withApp(fn) {
  const app = express();
  app.use('/api/integrations/yazheng', router);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}/api/integrations/yazheng/orders`); }
  finally { await new Promise((r) => srv.close(r)); }
}

const KEY = 'k'.repeat(40);

(async () => {
  await check('YZ-A3 簽章：sha256=HMAC(secret, "<ts>.<body>")，改一個字就不同', async () => {
    const want = 'sha256=' + crypto.createHmac('sha256', 's'.repeat(32)).update('1700000000.{"a":1}').digest('hex');
    assert.strictEqual(real.sign('s'.repeat(32), '1700000000', '{"a":1}'), want);
    assert.notStrictEqual(real.sign('s'.repeat(32), '1700000000', '{"a":2}'), want);
  });

  await check('YZ-A3 沒設網址或 secret 太短、不是 https → 不啟動', async () => {
    assert.strictEqual(real.webhookConfig({}), null);
    assert.strictEqual(real.webhookConfig({ YZ_WEBHOOK_URL: 'https://x.example', YZ_WEBHOOK_SECRET: 'short' }), null);
    assert.strictEqual(real.webhookConfig({ YZ_WEBHOOK_URL: 'http://x.example', YZ_WEBHOOK_SECRET: 's'.repeat(32) }), null);
    assert.deepStrictEqual(real.webhookConfig({ YZ_WEBHOOK_URL: 'https://x.example/h', YZ_WEBHOOK_SECRET: 's'.repeat(32) }),
      { url: 'https://x.example/h', secret: 's'.repeat(32) });
  });

  await check('分頁游標可來回轉換；壞游標丟 BAD_CURSOR', async () => {
    const c = real.encodeCursor({ changed_at: '2031-01-02T03:04:05.000Z', enrollment_id: 'ABL-1|x' });
    assert.deepStrictEqual(real.decodeCursor(c), { at: '2031-01-02T03:04:05.000Z', id: 'ABL-1|x' });
    assert.strictEqual(real.decodeCursor(null), null);
    assert.throws(() => real.decodeCursor(Buffer.from('nope').toString('base64url')), /bad cursor/);
  });

  await check('YZ-A2 欄位白名單：多出來的欄位（姓名、完整電話）不會出現在輸出', async () => {
    const rec = real.toRecord({ enrollment_id: 'e1', parent_name: '王小明', parent_phone: '0912000101', legacy_seq: '9',
      yazheng_tag: true, invoice_number: 'ZZ00000001', parent_phone_last4: '0101', course_type: '1', total_sessions: 6,
      used_sessions: 2, status: 'confirmed', created_at: '2031-01-01T00:00:00Z', updated_at: null, changed_at: '2031-01-01T00:00:00Z' });
    assert.deepStrictEqual(Object.keys(rec).sort(), ['changed_at', 'course_type', 'created_at', 'enrollment_id', 'external_order_no',
      'invoice_number', 'legacy_seq', 'legacy_seqs', 'parent_phone_last4', 'status', 'total_sessions', 'updated_at', 'used_sessions', 'yazheng_tag']);
    assert.ok(!JSON.stringify(rec).includes('0912000101'));
    assert.strictEqual(rec.course_type, 1);
  });

  await check('YZ-A2 沒設 YZ_SYNC_API_KEY → 503；太短也當沒設', async () => {
    delete process.env.YZ_SYNC_API_KEY;
    await withApp(async (url) => {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + KEY } });
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    });
    process.env.YZ_SYNC_API_KEY = 'short';
    await withApp(async (url) => assert.strictEqual((await fetch(url)).status, 503));
  });

  await check('YZ-A2 金鑰不對、缺少、格式不對 → 401，不呼叫查詢', async () => {
    process.env.YZ_SYNC_API_KEY = KEY;
    listCalls = [];
    await withApp(async (url) => {
      for (const h of [{}, { Authorization: 'Bearer wrong' }, { Authorization: KEY }, { Authorization: 'Bearer ' + KEY + 'x' }]) {
        const r = await fetch(url, { headers: h });
        assert.strictEqual(r.status, 401);
      }
    });
    assert.strictEqual(listCalls.length, 0);
  });

  await check('YZ-A2 金鑰對 → 200，since／cursor／limit 傳進查詢；壞參數 400', async () => {
    process.env.YZ_SYNC_API_KEY = KEY;
    listCalls = [];
    await withApp(async (url) => {
      const auth = { Authorization: 'Bearer ' + KEY };
      const cur = real.encodeCursor({ changed_at: '2031-01-01T00:00:00.000Z', enrollment_id: 'e9' });
      const r = await fetch(`${url}?since=2031-01-01T00:00:00Z&limit=50&cursor=${cur}`, { headers: auth });
      assert.strictEqual(r.status, 200);
      const body = await r.json();
      assert.deepStrictEqual(body.orders, [{ enrollment_id: 'e1' }]);
      assert.strictEqual(body.next, null);
      assert.deepStrictEqual(listCalls[0], { since: '2031-01-01T00:00:00Z', after: { at: '2031-01-01T00:00:00.000Z', id: 'e9' }, limit: '50' });
      assert.strictEqual((await fetch(`${url}?since=not-a-date`, { headers: auth })).status, 400);
      assert.strictEqual((await fetch(`${url}?cursor=${Buffer.from('x').toString('base64url')}`, { headers: auth })).status, 400);
    });
  });

  delete process.env.YZ_SYNC_API_KEY;
  if (failed) { console.error(`yazheng_sync_test: ${failed} 項失敗`); process.exit(1); }
  console.log('yazheng_sync_test: 全部通過');
})();
