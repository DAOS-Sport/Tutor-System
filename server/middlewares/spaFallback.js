/**
 * 路由兜底：未知 /api 一律 JSON 404；SPA fallback 只接「頁面」路徑。
 *
 * ── 為什麼要有這支（#12 假成功／路由不明稽核）──
 * 1. 未知的 /api/* 以前掉到 Express 內建 404，回的是一頁 HTML「Cannot GET …」。
 *    前端拿到的不是 JSON、沒有 .error／.code，畫面只能顯示籠統的失敗，
 *    監控也分不出「打錯路徑」和「伺服器掛了」。這裡統一回 JSON 404 + API_NOT_FOUND。
 * 2. /admin/* 與 /liff/* 的 SPA fallback 會把「任何」子路徑都回 index.html 200。
 *    舊版 bundle 去要一個已被 build 清掉的 /admin/assets/index-舊hash.js 時，拿到的是
 *    200 + text/html：瀏覽器報 MIME 錯誤、畫面白掉，伺服器 log 卻全是 200，看起來一切正常。
 *    相對路徑誤打成 /liff/api/... 也一樣會「成功」拿到一頁 HTML。
 *    這類「明顯不是頁面」的請求改回 404，讓錯誤看得見。
 */
const path = require('path');

// 靜態資源副檔名：SPA 路由不會長這樣（React Router 的路徑沒有副檔名）。
const ASSET_EXT_RE = /\.(?:js|mjs|cjs|css|map|json|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|txt|webmanifest)$/i;

/**
 * 給 SPA mount（/admin、/liff）之下的相對路徑判斷：是不是「不該拿到 index.html」的請求。
 * relPath 例：'/assets/index-abc.js'、'/api/x'、'/login'
 */
function isNonPagePath(relPath) {
  const p = String(relPath || '');
  if (/^\/(?:api|assets)(?:\/|$)/.test(p)) return true;
  return ASSET_EXT_RE.test(p);
}

function apiNotFound(req, res) {
  res.set('Cache-Control', 'no-store');
  res.status(404).json({
    error: '找不到這個 API 路徑；多半是頁面版本過舊，請重新整理後再試。',
    code: 'API_NOT_FOUND',
    path: req.originalUrl ? String(req.originalUrl).split('?')[0] : req.path,
  });
}

/**
 * 產生 SPA fallback handler（掛在 app.get('/admin/*') 這類路由上）。
 * mountPrefix：'/admin' 或 '/liff'；indexFile：該前端 index.html 的絕對路徑。
 */
function spaFallback(mountPrefix, indexFile) {
  return (req, res, next) => {
    const rel = req.path.slice(mountPrefix.length) || '/';
    if (isNonPagePath(rel)) {
      res.set('Cache-Control', 'no-store');
      if (/^\/api(?:\/|$)/.test(rel)) return apiNotFound(req, res);
      return res.status(404).type('text/plain').send('Not Found');
    }
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.resolve(indexFile), (err) => err && next(err));
  };
}

module.exports = { isNonPagePath, apiNotFound, spaFallback };
