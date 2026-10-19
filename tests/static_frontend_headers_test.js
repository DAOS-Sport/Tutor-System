/**
 * #15 第 2 步：前端靜態檔的快取／壓縮／缺檔規則。
 *
 * 守的是三件「壞了不會報錯、只會讓使用者慢或卡在舊版」的事：
 *   1. assets/ 底下的 hash 檔長快取 immutable；index.html 與 SPA fallback 一律 no-store
 *   2. 舊 chunk 名稱（部署後已不存在）回 404，絕不能被 SPA fallback 吃成 HTML 200 ——
 *      否則 React.lazy 載入失敗時看到的是 MIME 錯誤，前端無法判斷「該重新整理了」
 *   3. 有 Accept-Encoding 時回 br / gzip，內容解壓後與原檔一致；沒有時回原檔
 *
 * 用暫存目錄造一份假的 build 產物，起一個只掛這個 router 的 express，不碰 DB。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const express = require(path.join(ROOT, 'server/node_modules/express'));
const {
  createFrontendRouter, warmCompressedAssets, pickEncoding,
  ASSET_CACHE_CONTROL,
} = require(path.join(ROOT, 'server/middlewares/staticFrontend.js'));
// 缺檔 404 由 #12 的 spaFallback 負責；這裡照 server/index.js 的掛法一起掛，驗整條路徑。
const { spaFallback } = require(path.join(ROOT, 'server/middlewares/spaFallback.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'static-frontend-'));
const appDir = path.join(tmp, 'admin');
fs.mkdirSync(path.join(appDir, 'assets'), { recursive: true });
const INDEX = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';
fs.writeFileSync(path.join(appDir, 'index.html'), INDEX);
// 夠大、可壓縮的 JS（超過最小壓縮門檻）
const JS = 'export const x = ' + JSON.stringify('重複內容 '.repeat(4000)) + ';\n';
fs.writeFileSync(path.join(appDir, 'assets', 'index-NEWHASH1.js'), JS);
fs.writeFileSync(path.join(appDir, 'assets', 'index-NEWHASH1.css'), 'body{color:red}');
fs.writeFileSync(path.join(appDir, 'assets', 'logo-ABC.jpg'), Buffer.alloc(2048, 1));

const app = express();
const router = createFrontendRouter(appDir);
app.use('/admin', router);
app.get('/admin/*', spaFallback('/admin', path.join(appDir, 'index.html')));

function get(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  await check('index.html 與 /admin/ 為 no-store', async () => {
    for (const p of ['/admin/', '/admin/index.html']) {
      const r = await get(server, p);
      assert.strictEqual(r.status, 200, p);
      assert.strictEqual(r.headers['cache-control'], 'no-store', p);
      assert.match(r.headers['content-type'], /text\/html/, p);
    }
  });

  await check('SPA 子路徑 fallback 回 index.html 且 no-store', async () => {
    const r = await get(server, '/admin/dashboard');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.strictEqual(r.body.toString(), INDEX);
  });

  await check('hash 資產（未壓縮）長快取 immutable', async () => {
    const r = await get(server, '/admin/assets/index-NEWHASH1.css');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['cache-control'], ASSET_CACHE_CONTROL);
    assert.strictEqual(ASSET_CACHE_CONTROL, 'public, max-age=31536000, immutable');
    assert.match(r.headers['content-type'], /text\/css/);
    const img = await get(server, '/admin/assets/logo-ABC.jpg', { 'accept-encoding': 'br' });
    assert.strictEqual(img.headers['cache-control'], ASSET_CACHE_CONTROL);
    assert.strictEqual(img.headers['content-encoding'], undefined, '圖片不該再壓');
  });

  await check('舊 chunk 名稱回 404（不是 HTML 200），且 404 不快取', async () => {
    for (const p of ['/admin/assets/index-OLDHASH9.js', '/admin/assets/index-OLDHASH9.css',
      '/admin/assets/nested/missing.js', '/admin/old-chunk.js']) {
      const r = await get(server, p, { 'accept-encoding': 'br, gzip' });
      assert.strictEqual(r.status, 404, p + ' 應為 404，實際 ' + r.status);
      assert.doesNotMatch(String(r.headers['content-type']), /text\/html/, p);
      assert.strictEqual(r.headers['cache-control'], 'no-store', p);
    }
  });

  await check('Accept-Encoding: br → brotli，解壓後與原檔一致', async () => {
    const r = await get(server, '/admin/assets/index-NEWHASH1.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-encoding'], 'br');
    assert.match(r.headers.vary, /Accept-Encoding/i);
    assert.strictEqual(r.headers['cache-control'], ASSET_CACHE_CONTROL);
    assert.match(r.headers['content-type'], /javascript/);
    assert.strictEqual(Number(r.headers['content-length']), r.body.length);
    assert.ok(r.body.length < Buffer.byteLength(JS) / 5, '壓縮後應明顯變小');
    assert.strictEqual(zlib.brotliDecompressSync(r.body).toString(), JS);
  });

  await check('Accept-Encoding: gzip → gzip；沒有 → 原檔', async () => {
    const gz = await get(server, '/admin/assets/index-NEWHASH1.js', { 'accept-encoding': 'gzip' });
    assert.strictEqual(gz.headers['content-encoding'], 'gzip');
    assert.strictEqual(zlib.gunzipSync(gz.body).toString(), JS);
    const id = await get(server, '/admin/assets/index-NEWHASH1.js', { 'accept-encoding': 'identity' });
    assert.strictEqual(id.headers['content-encoding'], undefined);
    assert.strictEqual(id.body.toString(), JS);
    assert.strictEqual(id.headers['cache-control'], ASSET_CACHE_CONTROL);
    const q0 = await get(server, '/admin/assets/index-NEWHASH1.js', { 'accept-encoding': 'br;q=0, gzip' });
    assert.strictEqual(q0.headers['content-encoding'], 'gzip', 'br;q=0 代表拒收 br');
  });

  await check('壓縮回應的條件請求回 304', async () => {
    const r1 = await get(server, '/admin/assets/index-NEWHASH1.js', { 'accept-encoding': 'br' });
    const r2 = await get(server, '/admin/assets/index-NEWHASH1.js', { 'accept-encoding': 'br', 'if-none-match': r1.headers.etag });
    assert.strictEqual(r2.status, 304);
  });

  await check('路徑穿越不會讀到 assets 以外的檔案', async () => {
    const r = await get(server, '/admin/assets/..%2findex.html', { 'accept-encoding': 'br' });
    assert.notStrictEqual(r.headers['content-encoding'], 'br');
    assert.notStrictEqual(r.status, 500);
  });

  await check('預熱會把文字資產先壓好', async () => {
    const fresh = createFrontendRouter(appDir);
    const { files } = await warmCompressedAssets(appDir, fresh.compressedCache);
    assert.strictEqual(files, 1, '只有超過門檻的 js 會被預壓（css 太小、jpg 不壓）');
    assert.strictEqual(fresh.compressedCache.stats().entries, 2);
  });

  await check('pickEncoding', async () => {
    assert.strictEqual(pickEncoding('gzip, deflate, br'), 'br');
    assert.strictEqual(pickEncoding('gzip'), 'gzip');
    assert.strictEqual(pickEncoding(''), null);
    assert.strictEqual(pickEncoding('br;q=0'), null);
  });

  await check('server/index.js 透過 createFrontendRouter 掛載兩個前端', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.match(src, /createFrontendRouter\(path\.join\(PUBLIC_DIR, 'admin'\)\)/);
    assert.match(src, /createFrontendRouter\(path\.join\(PUBLIC_DIR, 'liff'\)\)/);
    assert.match(src, /app\.get\('\/admin\/\*', spaFallback\(/, '缺檔 404 靠 spaFallback');
    assert.match(src, /app\.get\('\/liff\/\*', spaFallback\(/, '缺檔 404 靠 spaFallback');
    // 靜態 router 必須在 SPA fallback 之前，否則存在的資產也會被當成頁面路徑
    assert.ok(src.indexOf("app.use('/admin', FRONTEND_ROUTERS.admin)") < src.indexOf("app.get('/admin/*', spaFallback("));
    assert.doesNotMatch(src, /express\.static\(path\.join\(PUBLIC_DIR, '(?:admin|liff)'\)/, '不要再繞過 createFrontendRouter');
  });

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `static_frontend_headers_test: ${failures} FAILED` : 'static_frontend_headers_test: PASS');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
