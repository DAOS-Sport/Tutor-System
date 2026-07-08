require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { initWebSocket } = require('./services/websocket');
const { initCronJobs } = require('./cron');
const { bootstrap: bootstrapAdmin } = require('./bootstrap/admin');
const { bootstrap: bootstrapCore } = require('./bootstrap/coreSchema');
const { bootstrap: bootstrapDemo } = require('./bootstrap/demoSeed');
const { assertSecretConfigured } = require('./middlewares/adminAuth');

const app = express();
const server = http.createServer(app);

// build 版本：優先讀 build 腳本產生的 build-info.json，退而求其次讀 git，最後 unknown。
// 讓 /health 能回報「線上伺服器到底是哪一版」，配合前端 DiagBlock 一起確認有沒有部署到最新。
const BUILD_INFO = (() => {
  try { return require('./build-info.json'); } catch { /* 尚未 build */ }
  try {
    const sha = require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return { sha: sha || 'unknown', time: null };
  } catch { return { sha: 'unknown', time: null }; }
})();

// SPA 的 index.html 一律不快取（JS/CSS 是 content-hash 檔，可長快取；只有 index.html
// 被 LINE 內建瀏覽器 / CDN 快取住，就會一直載到舊的 asset 參照 → 舊碼殘留）。
function noStoreHtml(res, filePath) {
  if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
}

app.use(cors({ origin: process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '*' }));
// express.json() 預設 strict：axios 的 `post(url, null)` 會把 body 序列化成字面字串 "null"，
// strict 模式視為非法 JSON → 400（前端 Ragic「立即同步 / 核准」按鈕送 null body，
// 每次點擊都在抵達路由前就 400 —— 正是「連不上 Ragic / 同步失敗」的真因）。
// 這裡包一層：把「空意圖」body（"null" / "undefined" / 空白）當成沒有 body、req.body = {} 放行；
// 真正壞掉的 JSON（如 `{bad`）仍交給檔尾的統一錯誤處理回友善 400。
const _jsonParser = express.json({ limit: '50mb' });
app.use((req, res, next) => _jsonParser(req, res, (err) => {
  if (err && err.type === 'entity.parse.failed') {
    const raw = typeof err.body === 'string' ? err.body.trim() : '';
    if (raw === '' || raw === 'null' || raw === 'undefined') {
      req.body = {};
      return next();
    }
  }
  next(err);
}));
app.use(express.urlencoded({ extended: true }));

// ── Routes ──────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/venues',        require('./routes/venues'));
app.use('/api/coaches',       require('./routes/coaches'));
app.use('/api/coach-portal',  require('./routes/coachPortal')); // 教練端 LINE OAuth 登入模組（與家長端分離）
app.use('/api/parents',       require('./routes/parents'));
app.use('/api/courses',       require('./routes/courses'));
app.use('/api/slots',         require('./routes/slots'));        // coach_availability_slots
app.use('/api/sessions',      require('./routes/sessions'));     // course_sessions
app.use('/api/checkins',      require('./routes/checkins'));
app.use('/api/promotions',    require('./routes/promotions'));
app.use('/api/enrollments',   require('./routes/enrollments'));  // F-S02 LIFF 報名建立 + promotion_usages
app.use('/api/group-orders',  require('./routes/groupOrders'));  // U6 團購（家長端）
app.use('/api/uploads',       require('./routes/uploads'));      // U3 家長端匯款證明上傳
app.use('/api/referrals',     require('./routes/referrals'));    // MGM
app.use('/api/transfers',     require('./routes/transfers'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/learn',         require('./routes/learn'));        // 學習歷程
app.use('/api/evaluations',   require('./routes/evaluations'));  // 期末評鑑
app.use('/api/ragic-webhook', require('./routes/ragicWebhook'));  // Ragic webhook：只信 record id，必 re-fetch
app.use('/api/admin',         require('./routes/admin'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString(), build: BUILD_INFO }));

// MGM 短連結：/r/:token → /liff/register?ref=<token>
app.get('/r/:token', (req, res) => {
  const tk = encodeURIComponent(String(req.params.token || ''));
  res.redirect(302, `/liff/register?ref=${tk}`);
});

// ── Static frontends ────────────────────────
// Vite 會把 admin / liff 兩個前端 build 到 server/public/{admin,liff}
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/admin', express.static(path.join(PUBLIC_DIR, 'admin'), { setHeaders: noStoreHtml }));
app.use('/liff', express.static(path.join(PUBLIC_DIR, 'liff'), { setHeaders: noStoreHtml }));

// 聊天室媒體上傳（Phase 4）／匯款證明：以 /uploads 對外。
// 安全：強制 X-Content-Type-Options + 對非媒體型一律以 attachment 下載，避免同源 XSS / iframe sandbox 逃逸。
const objectStore = require('./services/objectStorage');
const mime = require('mime-types');

// 三道安全防線（local 與 bucket 兩條路徑共用）：nosniff + CSP sandbox +
// 對非媒體副檔名一律 attachment 下載。傳入的是檔名或路徑，只看副檔名。
function setUploadSecurityHeaders(res, nameOrPath) {
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  const isMedia = /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|m4v|mov|webm|mp3|wav|m4a|aac|ogg|amr)$/i.test(nameOrPath);
  if (!isMedia) res.setHeader('Content-Disposition', 'attachment');
}

if (objectStore.driverName === 'replit') {
  // 正式環境（Autoscale 多實例）：檔案存在共享 bucket，非本機磁碟。
  // 由此 handler 依對外 URL 還原 key、從 bucket 串流回應（含相同三道安全標頭）。
  app.get('/uploads/*', (req, res) => {
    setUploadSecurityHeaders(res, req.path);
    res.setHeader('Content-Type', mime.lookup(req.path) || 'application/octet-stream');
    const stream = objectStore.openReadStream(req.path);
    if (!stream) return res.status(404).json({ error: '檔案不存在' });
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: '檔案不存在' }); else res.destroy(); });
    stream.pipe(res);
  });
} else {
  // dev / 單機：本機 server/uploads 直接以 express.static 提供。
  app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    maxAge: '7d',
    setHeaders(res, filePath) { setUploadSecurityHeaders(res, filePath); },
  }));
}

// SPA fallback：將子路徑導回對應前端的 index.html，讓 React Router 接手
app.get('/admin/*', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'), (err) => err && next(err));
});
app.get('/liff/*', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'liff', 'index.html'), (err) => err && next(err));
});

// 根路徑：若是從 LINE LIFF 開啟（會帶 liff.state / liff.referrer 等 query），
// 導去 /liff/ 並保留原本 query；其餘一律導向後台首頁。
app.get('/', (req, res) => {
  const isLiff = Object.keys(req.query).some((k) => k.startsWith('liff.'));
  if (isLiff) {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect('/liff/' + qs);
  }
  res.redirect('/admin/');
});

// ── 統一錯誤處理（必須放在所有 route 之後）──────────────
// 之前沒有 error handler：express.json() 遇到壞掉的 JSON body 會丟 SyntaxError，
// 由 Express 內建 handler 回一頁「HTML 堆疊」+ 400（body 沒有 .error 欄位）。
// 前端 6 個後台頁的 catch 都是 `toast.error(e.response.data.error || e.message)`，
// 抓不到 .error → 退回 e.message = 神祕的「Request failed with status code 400」
// （Ragic 連線狀態頁「連不上」的真正成因）。這裡一律改回乾淨 JSON，讓前端顯示
// 友善中文、並提示重新整理（多半是瀏覽器卡在舊版 bundle 送出異常 body）。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isBodyParse =
    err.type === 'entity.parse.failed' ||
    err.type === 'entity.too.large' ||
    (err instanceof SyntaxError && 'body' in err);
  if (isBodyParse) {
    const tooLarge = err.type === 'entity.too.large';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? '上傳內容過大，請縮小後再試。'
        : '請求內容格式錯誤（JSON 解析失敗）；多半是頁面版本過舊，請重新整理頁面後再試。',
    });
  }
  console.error('[unhandled]', req.method, req.originalUrl, err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// ── WebSocket (聊天室) ───────────────────────
initWebSocket(server);

// ── Cron Jobs ───────────────────────────────
initCronJobs();

const PORT = process.env.PORT || 3000;

// 啟動順序：
// 1) production 必須有 JWT_SECRET（assertSecretConfigured 會 throw 讓 process exit）
// 2) 立即 listen——讓 port 先綁好，autoscale health probe 可立刻通過
// 3) bootstrap admin_* 表、core schema、demo seed（非同步，不阻塞 health check）
(async () => {
  try {
    assertSecretConfigured();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  // 先 listen，health probe (GET /) 可立刻回 302→200，不會 timeout
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`DAOS Server running on port ${PORT}`);
  });
  // bootstrap 在背景執行；失敗只影響對應功能，不阻擋已監聽的 port
  try {
    await bootstrapAdmin();
  } catch (err) {
    console.error('Admin bootstrap failed (server will still start, but /api/admin may error):', err.message);
  }
  try {
    await bootstrapCore();
  } catch (err) {
    console.error('Core schema bootstrap failed (LIFF coach module may error):', err.message);
  }
  try {
    await bootstrapDemo();
  } catch (err) {
    console.error('Demo seed bootstrap failed (DEMO_SEED ignored):', err.message);
  }
})();
