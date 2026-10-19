'use strict';
/**
 * 前端（admin / liff）靜態檔的傳送規則（#15 第 2 步）。
 *
 * 為什麼要自己包一層而不是直接 express.static：
 *
 * 1. 快取：Vite 產物在 assets/ 底下，檔名帶 content hash，內容變了檔名就變，
 *    所以可以放心長快取一年 + immutable。原本 express.static 預設 max-age=0，
 *    每次開頁都要對 1.3 MB 的 bundle 發一次條件請求，LINE 內建瀏覽器上尤其慢。
 *    相反地 index.html 必須 no-store：它是唯一知道「現在該載哪個 hash」的檔案，
 *    被快取住就會一直跑舊版（這條原本就有，這裡保留）。
 *
 * 2. 缺檔不在這裡處理：這個 router 找不到檔案就 next()，交給 index.js 的
 *    app.get('/admin/*', spaFallback(...))（middlewares/spaFallback.js，#12）——
 *    它對 assets/ 與帶副檔名的路徑回 404，不再把舊 chunk 名稱吃成 index.html 200。
 *    路由切分（React.lazy）之後「部署後要舊 chunk」更常見，前端的對應在
 *    client/shared/chunkRetry.js。
 *
 * 3. 壓縮：不加 npm 套件（compression），用 Node 內建 zlib。資產檔不可變，
 *    所以每個檔案只壓一次、結果留在記憶體，之後每個請求都是直接送 buffer。
 *    brotli 用品質 6：本機量測 1.3 MB bundle q6 約 95 ms、q11 約 3.2 秒，
 *    體積只差約 10%；q11 在 Autoscale 冷啟動時會吃掉太多 CPU，不划算。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');

const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'no-store';

// 值得壓縮的文字型資產；圖片／字型本身已壓縮，再壓只是浪費 CPU。
const COMPRESSIBLE = /\.(?:js|mjs|css|svg|json|map|txt)$/i;
// 小檔壓縮省不到幾個位元組，還多一次 Vary 協商，不值得。
const MIN_COMPRESS_BYTES = 1024;
// 記憶體上限：正常一次 build 的 js+css 壓縮後兩種編碼合計不到 2 MB，
// 這個上限只是防止 assets/ 堆了大量殘檔時無限長大。
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

function pickEncoding(acceptEncoding) {
  const ae = String(acceptEncoding || '').toLowerCase();
  // 不完整解析 q 值：只要明確寫 q=0 就視為拒收，其餘有列出即可用。
  const accepts = (name) => {
    const m = ae.match(new RegExp('(?:^|,)\\s*' + name + '\\s*(;\\s*q\\s*=\\s*([0-9.]+))?\\s*(?:,|$)'));
    if (!m) return false;
    return m[2] === undefined || Number(m[2]) > 0;
  };
  if (accepts('br')) return 'br';
  if (accepts('gzip')) return 'gzip';
  return null;
}

function compressBuffer(buf, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === 'br') {
      zlib.brotliCompress(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      }, (err, out) => (err ? reject(err) : resolve(out)));
    } else {
      zlib.gzip(buf, { level: 9 }, (err, out) => (err ? reject(err) : resolve(out)));
    }
  });
}

/**
 * 預先壓縮好的資產快取。key 帶上 mtime 與大小：同一路徑被新 build 覆寫時
 * （本機 dev 常見）不會送出舊內容。
 */
function createCompressedCache() {
  const entries = new Map(); // key -> Promise<{ body, etag }>
  let bytes = 0;

  async function get(filePath, stat, encoding) {
    const key = `${filePath}|${stat.mtimeMs}|${stat.size}|${encoding}`;
    let p = entries.get(key);
    if (!p) {
      p = (async () => {
        const raw = await fs.promises.readFile(filePath);
        const body = await compressBuffer(raw, encoding);
        if (bytes + body.length <= MAX_CACHE_BYTES) {
          bytes += body.length;
        } else {
          // 超過上限：這次照送，但不留在快取裡。
          entries.delete(key);
        }
        return { body, etag: `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${encoding}"` };
      })();
      entries.set(key, p);
      // 壓縮失敗不要把壞掉的 promise 永久留著，下次再試。
      p.catch(() => entries.delete(key));
    }
    return p;
  }

  return { get, stats: () => ({ entries: entries.size, bytes }) };
}

function compressedAssets(assetsDir, cache) {
  const root = path.resolve(assetsDir);
  return async function serveCompressed(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.headers.range) return next(); // Range 交給 express.static，避免壓縮後位移對不上
    const encoding = pickEncoding(req.headers['accept-encoding']);
    if (!encoding) return next();
    let rel;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    if (!COMPRESSIBLE.test(rel)) return next();
    const filePath = path.resolve(root, '.' + rel);
    // 防路徑穿越：解析後必須仍在 assets 目錄內。
    if (!filePath.startsWith(root + path.sep)) return next();
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch { return next(); }
    if (!stat.isFile() || stat.size < MIN_COMPRESS_BYTES) return next();
    let entry;
    try {
      entry = await cache.get(filePath, stat, encoding);
    } catch (err) {
      // 壓縮出錯就退回未壓縮的原檔，不讓使用者因為最佳化失敗而載不到頁面。
      console.warn('[static] compress failed, serving identity:', rel, err.message);
      return next();
    }
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', ASSET_CACHE_CONTROL);
    res.setHeader('ETag', entry.etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.type(path.extname(filePath));
    if (req.fresh) return res.status(304).end();
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', entry.body.length);
    if (req.method === 'HEAD') return res.end();
    return res.end(entry.body);
  };
}

function noStoreHtml(res, filePath) {
  if (filePath.endsWith('.html')) res.setHeader('Cache-Control', HTML_CACHE_CONTROL);
}

/**
 * 建立一個前端 app 的靜態檔 router，掛在 /admin 或 /liff（SPA fallback 另外掛）。
 * @param {string} dir  server/public/<app>（含 index.html 與 assets/）
 * @param {{ compress?: boolean, cache?: object }} [opts]
 */
function createFrontendRouter(dir, opts = {}) {
  const compress = opts.compress !== false;
  const cache = opts.cache || createCompressedCache();
  const assetsDir = path.join(dir, 'assets');
  const router = express.Router();

  if (compress) router.use('/assets', compressedAssets(assetsDir, cache));
  router.use('/assets', express.static(assetsDir, {
    index: false,
    redirect: false,
    maxAge: '1y',
    immutable: true,
    setHeaders: (res) => res.setHeader('Vary', 'Accept-Encoding'),
  }));
  // 根目錄的 index.html 等：HTML 一律 no-store。找不到的路徑 next() 給 spaFallback。
  router.use(express.static(dir, { setHeaders: noStoreHtml }));

  router.compressedCache = cache;
  return router;
}

/**
 * 在背景把 assets/ 底下的文字資產先壓好，讓第一位使用者不必等壓縮。
 * 依序做、不並行，避免開機瞬間把 CPU 吃滿。失敗只記 log。
 */
async function warmCompressedAssets(dir, cache) {
  const assetsDir = path.join(dir, 'assets');
  let names = [];
  try { names = await fs.promises.readdir(assetsDir); } catch { return { files: 0 }; }
  let files = 0;
  for (const name of names) {
    if (!COMPRESSIBLE.test(name)) continue;
    const filePath = path.join(assetsDir, name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size < MIN_COMPRESS_BYTES) continue;
      await cache.get(filePath, stat, 'br');
      await cache.get(filePath, stat, 'gzip');
      files++;
    } catch (err) {
      console.warn('[static] warm-up failed:', name, err.message);
    }
  }
  return { files };
}

module.exports = {
  ASSET_CACHE_CONTROL,
  HTML_CACHE_CONTROL,
  createFrontendRouter,
  createCompressedCache,
  warmCompressedAssets,
  pickEncoding,
};
