'use strict';
// 大型 API JSON 壓縮：只壓 ≥ 64 KB 的 res.json()，內容、狀態碼、ETag／304 與壓縮前相同。
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require(require.resolve('express', { paths: [path.join(__dirname, '../server')] }));
const { compressLargeJson, THRESHOLD_BYTES } = require('../server/middlewares/compressJson');

const big = Array.from({ length: 2000 }, (_, i) => ({ id: i, parent_name: '合成家長', status: 'paid', note: 'x'.repeat(40) }));
const small = { ok: true };

const app = express();
app.use('/api', compressLargeJson());
app.get('/api/big', (req, res) => res.json(big));
app.get('/api/small', (req, res) => res.json(small));
app.get('/api/missing', (req, res) => res.status(404).json({ error: 'nope', rows: big }));
app.get('/api/headers', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(big); });

function request(server, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const decode = (r) => {
  const enc = r.headers['content-encoding'];
  const raw = enc === 'br' ? zlib.brotliDecompressSync(r.body) : enc === 'gzip' ? zlib.gunzipSync(r.body) : r.body;
  return JSON.parse(raw.toString('utf8'));
};

(async () => {
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > THRESHOLD_BYTES, 'fixture 要超過門檻');
  const server = app.listen(0);
  try {
    for (const [ae, expected] of [['br, gzip', 'br'], ['gzip', 'gzip'], ['gzip, br;q=0', 'gzip']]) {
      const r = await request(server, '/api/big', { headers: { 'accept-encoding': ae } });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-encoding'], expected, `Accept-Encoding: ${ae}`);
      assert.match(r.headers['content-type'], /^application\/json/);
      assert.match(r.headers.vary || '', /Accept-Encoding/i);
      assert.equal(Number(r.headers['content-length']), r.body.length);
      assert.ok(r.body.length < JSON.stringify(big).length / 5, '壓縮後應明顯變小');
      assert.deepEqual(decode(r), big, '解壓後內容必須與原本相同');
    }

    const none = await request(server, '/api/big', { headers: {} });
    assert.equal(none.headers['content-encoding'], undefined, '沒有 Accept-Encoding 不壓縮');
    assert.deepEqual(decode(none), big);

    const s = await request(server, '/api/small', { headers: { 'accept-encoding': 'br' } });
    assert.equal(s.headers['content-encoding'], undefined, '小回應不壓縮');
    assert.deepEqual(decode(s), small);

    const miss = await request(server, '/api/missing', { headers: { 'accept-encoding': 'br' } });
    assert.equal(miss.status, 404, '狀態碼要保留');
    assert.deepEqual(decode(miss), { error: 'nope', rows: big });

    const h = await request(server, '/api/headers', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(h.headers['cache-control'], 'no-store', '路由自己設的標頭要保留');

    const first = await request(server, '/api/big', { headers: { 'accept-encoding': 'br' } });
    assert.ok(first.headers.etag, '要有 ETag');
    const again = await request(server, '/api/big', { headers: { 'accept-encoding': 'br', 'if-none-match': first.headers.etag } });
    assert.equal(again.status, 304, 'ETag 相同時回 304');

    const head = await request(server, '/api/big', { method: 'HEAD', headers: { 'accept-encoding': 'br' } });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-encoding'], undefined, 'HEAD 不壓縮');

    console.log('PASS 大型 API JSON 壓縮：br／gzip 依 Accept-Encoding、內容不變、小回應與 HEAD 不壓、狀態碼／標頭／304 保留');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
