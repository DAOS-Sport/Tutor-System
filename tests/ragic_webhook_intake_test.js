/**
 * Ragic Webhook 收件（2026-09-23）：在 Ragic Z01 改了資料，系統卻「沒進來」。
 *
 * 根因：webhook 路由掛在全域 express.json()／urlencoded 之後，只有 Content-Type 是
 * application/json 才解析得到；text/plain、表單格式、沒標一律 400，而且被拒的請求不留任何紀錄，
 * 分不出是 Ragic 沒送還是送了被擋。Ragic 文件只寫內容格式，沒寫 Content-Type。
 *
 * 這支用真的 express 起一個只聽 127.0.0.1 的伺服器，照 index.js 的順序掛路由（webhook 在前、
 * 全域 parser 在後），驗證：各種 Content-Type 都解析得到、每次請求都留紀錄、紀錄裡沒有密碼。
 * ragicAdmin 以 stub 取代（不連 DB、不打 Ragic）；取編號用的是正式程式同一支純函式。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const express = require(path.join(SERVER, 'node_modules/express'));
const webhookBody = require(path.join(SERVER, 'services/ragicWebhookBody'));

const SECRET = 'fixture-secret-000000000000000000';
const handled = [];
const recorded = [];

function stub(rel, exportsObj) {
  const file = require.resolve(path.join(SERVER, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
  return file;
}
stub('services/ragicAdmin.js', {
  async handleRagicWebhook(sheetCode, parsed) {
    const ids = webhookBody.extractWebhookRecordIds(parsed);
    if (!ids.length || ids.length > 100 || ids.some((id) => !/^\d+$/.test(id))) {
      throw Object.assign(new Error('webhook payload requires 1-100 numeric record ids'), { code: 'RAGIC_WEBHOOK_INVALID' });
    }
    handled.push({ sheetCode, ids });
    return { ok: true, count: ids.length };
  },
});
const attemptsFile = stub('services/ragicWebhookAttempts.js', { record: (entry) => { recorded.push(entry); } });

process.env.NODE_ENV = 'production';
process.env.RAGIC_WEBHOOK_SECRET = SECRET;
const router = require(path.join(SERVER, 'routes/ragicWebhook.js'));

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

function send(port, { method = 'POST', pathname, contentType, payload }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (contentType) headers['Content-Type'] = contentType;
    const data = payload == null ? null : Buffer.from(payload);
    if (data) headers['Content-Length'] = data.length;
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // ── 1. 原始文字解析（純函式）─────────────────────────────────────────
  await check('原始文字解析：Ragic 文件上的兩種格式與邊界情況', () => {
    assert.deepEqual(webhookBody.extractWebhookRecordIds(webhookBody.parseWebhookBody('[1, 2, 4]')), ['1', '2', '4']);
    assert.deepEqual(
      webhookBody.extractWebhookRecordIds(webhookBody.parseWebhookBody('{"data":[{"_ragicId":6793}],"eventType":"UPDATE"}')),
      ['6793']);
    assert.deepEqual(webhookBody.parseWebhookBody('6793'), ['6793']);
    assert.deepEqual(webhookBody.parseWebhookBody('6793, 6794'), ['6793', '6794']);
    assert.deepEqual(webhookBody.parseWebhookBody(''), {});
    assert.deepEqual(webhookBody.parseWebhookBody('hello'), {});
    assert.deepEqual(webhookBody.parseWebhookBody('-5'), {}, '負數不是 record id');
    assert.deepEqual(webhookBody.parseWebhookBody({ id: '42' }), { id: '42' }, '已解析的物件原樣交出');
    assert.equal(webhookBody.describeBody([1]), 'array');
    assert.equal(webhookBody.describeBody({}), 'empty');
  });

  // ── 2. 真的 express，照 index.js 的順序 ────────────────────────────
  const app = express();
  app.use('/api/ragic-webhook', router);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.post('/api/other', (req, res) => res.json({ body: req.body }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = (code, secret = SECRET) => `/api/ragic-webhook/${code}?secret=${encodeURIComponent(secret)}`;

  try {
    const cases = [
      ['application/json 編號陣列', 'application/json', '[6793]', ['6793']],
      ['text/plain 編號陣列', 'text/plain', '[6793]', ['6793']],
      ['text/plain; charset=UTF-8 多筆', 'text/plain; charset=UTF-8', '[6793,6794]', ['6793', '6794']],
      ['表單格式（x-www-form-urlencoded）', 'application/x-www-form-urlencoded', '[6793]', ['6793']],
      ['沒標 Content-Type', null, '[6793]', ['6793']],
      ['完整內容格式、text/plain', 'text/plain', '{"data":[{"_ragicId":6793}],"eventType":"UPDATE"}', ['6793']],
    ];
    for (const [label, contentType, payload, expectIds] of cases) {
      await check(`${label} → 200 並留紀錄`, async () => {
        handled.length = 0; recorded.length = 0;
        const r = await send(port, { pathname: url('Z01'), contentType, payload });
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(handled[0] && handled[0].ids, expectIds);
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0].outcome, 'ok');
        assert.equal(recorded[0].idCount, expectIds.length);
      });
    }

    await check('密碼不符 → 401，不處理，有紀錄且紀錄裡沒有密碼', async () => {
      handled.length = 0; recorded.length = 0;
      const r = await send(port, { pathname: url('Z01', 'wrong-secret'), contentType: 'text/plain', payload: '[6793]' });
      assert.equal(r.status, 401);
      assert.equal(handled.length, 0);
      assert.equal(recorded[0].outcome, 'unauthorized');
      const dump = JSON.stringify(recorded);
      assert.ok(!dump.includes(SECRET) && !dump.includes('wrong-secret'), '紀錄裡不能出現網址參數');
    });

    await check('看不懂的內容 → 400 invalid_payload 並留紀錄', async () => {
      recorded.length = 0;
      const r = await send(port, { pathname: url('Z02'), contentType: 'text/plain', payload: 'hello' });
      assert.equal(r.status, 400);
      assert.equal(recorded[0].outcome, 'invalid_payload');
      assert.equal(recorded[0].bodyKind, 'empty');
      assert.equal(recorded[0].sheetCode, 'Z02');
    });

    await check('GET → 405（只收 POST）並留紀錄', async () => {
      recorded.length = 0;
      const r = await send(port, { method: 'GET', pathname: url('Z01') });
      assert.equal(r.status, 405);
      assert.equal(r.headers.allow, 'POST');
      assert.equal(recorded[0].outcome, 'method_not_allowed');
    });

    await check('其他路由不受影響：全域 JSON parser 照常運作', async () => {
      const r = await send(port, { pathname: '/api/other', contentType: 'application/json', payload: '{"a":1}' });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.text).body, { a: 1 });
    });
  } finally {
    server.close();
  }

  // ── 3. index.js 掛載順序 ───────────────────────────────────────────
  await check('index.js：webhook 掛在全域 JSON parser 之前，而且只掛一次', () => {
    const src = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
    const mount = "app.use('/api/ragic-webhook'";
    assert.equal(src.split(mount).length - 1, 1);
    const jsonAt = src.indexOf('app.use((req, res, next) => _jsonParser(');
    assert.ok(jsonAt > 0, '找不到全域 JSON parser');
    assert.ok(src.indexOf(mount) < jsonAt, 'webhook 必須在全域 JSON parser 之前');
  });

  // ── 4. 請求紀錄本身：節流、失敗不 throw ─────────────────────────────
  await check('請求紀錄：每分鐘最多 60 筆；DB 出錯只回 false，不 throw', async () => {
    delete require.cache[attemptsFile];
    const real = require(attemptsFile);
    real._resetForTest();
    const queries = [];
    const db = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
    for (let i = 0; i < real.MAX_PER_MINUTE + 5; i++) {
      await real.record({ method: 'POST', sheetCode: 'Z01', status: 200, outcome: 'ok' }, db);
    }
    const inserts = queries.filter((q) => /INSERT INTO ragic_webhook_attempts/.test(q.sql));
    assert.equal(inserts.length, real.MAX_PER_MINUTE);
    real._resetForTest();
    const warn = console.warn; console.warn = () => {};
    try {
      const ok = await real.record({ method: 'POST', status: 401, outcome: 'unauthorized' }, { query: async () => { throw new Error('boom'); } });
      assert.equal(ok, false);
    } finally { console.warn = warn; }
  });

  if (failures) {
    console.error(`ragic_webhook_intake_test: ${failures} FAIL`);
    process.exit(1);
  }
  console.log('ragic_webhook_intake_test: PASS');
})().catch((e) => { console.error(e); process.exit(1); });
