// 全站統一台灣時區（見 models/db.js 的 DB session 設定）：Node 執行期本身也強制
// 固定，避免部署環境（Docker/不同雲端機房）系統時區不一致，導致 new Date() 相關的
// 本地時間 getter/setter（如 bootstrap 種子資料的 relDays()）解讀出錯的時間。
process.env.TZ = 'Asia/Taipei';

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
const { pool } = require('./models/db');
const { formatTaipeiDateTime, TAIPEI_TIME_ZONE } = require('./utils/dateTime');

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
// ── MCP Server（Claude Desktop / Claude.ai 工作區遠端操控）────────────
const { createMcpRouter } = require('./mcp');
app.use('/mcp', createMcpRouter());

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
app.use('/api/checkout',      require('./routes/checkout'));     // checkout 母單付款頁
app.use('/api/group-orders',  require('./routes/groupOrders'));  // U6 團購（家長端）
app.use('/api/uploads',       require('./routes/uploads'));      // U3 家長端匯款證明上傳
app.use('/api/referrals',     require('./routes/referrals'));    // MGM
app.use('/api/transfers',     require('./routes/transfers'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/learn',         require('./routes/learn'));        // 學習歷程
app.use('/api/evaluations',   require('./routes/evaluations'));  // 期末評鑑
app.use('/api/ragic-webhook', require('./routes/ragicWebhook'));  // Ragic webhook：只信 record id，必 re-fetch
app.use('/api/admin',         require('./routes/admin'));

// 舊 LINE Console 曾被文件指向無 `/api` 前綴的 callback。相容入口不接收 OAuth
// code/state，也不會建立或綁定帳號；安全地丟棄 query 後回正式 LIFF bind 頁，
// 由 LIFF SDK + 後端 id_token 驗證走既有流程，避免白頁與 token/UID 出現在 URL。
app.get('/auth/line/callback', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(303, '/liff/bind?source=legacy-callback');
});

// Health check
app.get('/health', async (req, res) => {
  const now = new Date();
  let dbTimeZone = null;
  let dbNowUtc = null;
  try {
    const db = await pool.query(
      `SELECT current_setting('TimeZone') AS timezone,
              to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS utc_now`
    );
    dbTimeZone = db.rows[0]?.timezone || null;
    dbNowUtc = db.rows[0]?.utc_now || null;
  } catch (err) {
    console.warn('[health] DB timezone probe failed:', err.message);
  }
  res.json({
    status: 'ok',
    ts: now.toISOString(),
    build: BUILD_INFO,
    timezone: {
      application: process.env.TZ || TAIPEI_TIME_ZONE,
      database: dbTimeZone,
      utc_now: now.toISOString(),
      database_utc_now: dbNowUtc,
      taipei_now: formatTaipeiDateTime(now, { seconds: true }),
    },
  });
});

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

// 安全標頭（local 與 bucket 兩條路徑共用）：nosniff + CSP sandbox +
// 對非媒體副檔名一律 attachment 下載。傳入的是檔名或路徑，只看副檔名。
// 快取標頭刻意不在這裡設：只有「成功且有內容」的回應才能長快取；404/502 等
// 暫時性錯誤必須 no-store，否則一次 transient miss 會被瀏覽器 immutable 快取
// 7 天，讓稍後才補上／儲存恢復的照片在櫃檯端持續顯示成壞圖（對帳照片「失效」）。
function setUploadSecurityHeaders(res, nameOrPath) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  const isMedia = /\.(jpg|jpeg|jfif|png|gif|webp|heic|heif|avif|mp4|m4v|mov|webm|mp3|wav|m4a|aac|ogg|amr)$/i.test(nameOrPath);
  if (!isMedia) res.setHeader('Content-Disposition', 'attachment');
}

const UPLOAD_SUCCESS_CACHE = 'public, max-age=604800, immutable';

function sendUploadError(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error: message });
}

// /uploads/* — 由 objectStorage.openUpload 解析來源：bucket 串流、PostgreSQL
// uploaded_files buffer、或 local dev 磁碟。三個來源共用同一個 /uploads URL
// namespace 並做 read-through——bucket 不可用期間上傳的檔案存於 DB，bucket 恢復
// 後同一 URL 仍可讀。production 絕不落本機磁碟（Autoscale 換實例／重部署即 404）。
app.get('/uploads/*', async (req, res) => {
  setUploadSecurityHeaders(res, req.path);
  try {
    const found = await objectStore.openUpload(req.path);
    if (!found) return sendUploadError(res, 404, '檔案不存在');
    if (found.kind === 'file') {
      // local dev：不能用 express.static（route handler 不剝 /uploads 前綴），改 sendFile。
      // sendFile 自帶成功回應的 Cache-Control（maxAge/immutable）。
      return res.sendFile(found.path, { maxAge: '7d', immutable: true }, (err) => {
        if (err) sendUploadError(res, 404, '檔案不存在');
      });
    }
    res.setHeader('Cache-Control', UPLOAD_SUCCESS_CACHE);
    res.setHeader('Content-Type', found.mimeType || mime.lookup(req.path) || 'application/octet-stream');
    if (found.kind === 'buffer') return res.send(found.buffer);
    found.stream.on('error', (err) => {
      const msg = err?.message || String(err);
      console.error('[uploads/stream]', req.path, msg.slice(0, 200));
      // exists() 已在 openUpload 內確認過；走到這裡是讀取階段的傳輸錯誤，屬 5xx 而非 404。
      sendUploadError(res, 502, '檔案暫時無法讀取，請稍後再試');
    });
    found.stream.pipe(res);
  } catch (err) {
    console.error('[uploads/serve]', req.path, String(err?.message || err).slice(0, 200));
    sendUploadError(res, 502, '檔案暫時無法讀取，請稍後再試');
  }
});

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

const PORT = process.env.PORT || 3000;

// 啟動順序：
// 1) production 必須有 JWT_SECRET（assertSecretConfigured 會 throw 讓 process exit）
// 2) 先完成 admin/core 的 additive schema bootstrap；任何失敗都不接受流量
// 3) schema ready 後才 listen，health=ok 代表 API 可使用，不會出現「health 已綠但新欄位
//    尚未建立」的暫態 500。這也使部署平台保留上一個健康版本而非提早切流。
// Demo seed 不是正式功能前置條件，維持 best-effort 且只在 DEMO_SEED 明確設定時才動作。
(async () => {
  // Bootstrap retry: deadlock (40P01) is transient — retry up to 3 times with backoff.
  async function runBootstrap () {
    assertSecretConfigured();
    await bootstrapAdmin();
    await bootstrapCore();
  }
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await runBootstrap();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const isDeadlock = err.code === '40P01' || /deadlock/i.test(err.message);
      if (isDeadlock && attempt < 3) {
        const wait = attempt * 2000;
        console.warn(`[bootstrap] deadlock on attempt ${attempt}, retrying in ${wait}ms…`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        break;
      }
    }
  }
  if (lastErr) {
    console.error('Startup schema bootstrap failed; refusing to accept traffic:', lastErr.message);
    process.exit(1);
    return;
  }
  try {
    await objectStore.assertProductionStorageReady();
  } catch (err) {
    // bucket 未開通／異常：降級到 PostgreSQL 耐久儲存，部署照常成功、照片不消失。
    // 絕不可退回本機磁碟——Autoscale 換實例即 404、objectExists 跨實例驗證失敗，
    // 正是「家長上傳成功、對帳清單卻讀不到照片」的根因。
    console.warn('[objectStorage] bucket preflight failed; using durable PostgreSQL upload storage instead:', err.message);
    try {
      await objectStore.useFallbackDbDriver();
    } catch (dbErr) {
      console.error('[objectStorage] durable DB upload storage also unavailable; refusing to start:', dbErr.message);
      process.exit(1);
      return;
    }
  }
  try {
    await bootstrapDemo();
  } catch (err) {
    console.error('Demo seed bootstrap failed (DEMO_SEED ignored):', err.message);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`DAOS Server running on port ${PORT}`);
    // 排程只在 schema ready 後啟動，避免剛部署時對尚未升級的資料表讀寫。
    initCronJobs();
  });
})();
