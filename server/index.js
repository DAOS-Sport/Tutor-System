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

app.use(cors({ origin: process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '*' }));
app.use(express.json({ limit: '50mb' }));
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
app.use('/api/admin',         require('./routes/admin'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// MGM 短連結：/r/:token → /liff/register?ref=<token>
app.get('/r/:token', (req, res) => {
  const tk = encodeURIComponent(String(req.params.token || ''));
  res.redirect(302, `/liff/register?ref=${tk}`);
});

// ── Static frontends ────────────────────────
// Vite 會把 admin / liff 兩個前端 build 到 server/public/{admin,liff}
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/admin', express.static(path.join(PUBLIC_DIR, 'admin')));
app.use('/liff', express.static(path.join(PUBLIC_DIR, 'liff')));

// 聊天室媒體上傳（Phase 4）：本機 server/uploads 直接以 /uploads 對外
// 安全：強制 X-Content-Type-Options + 對非媒體型一律以 attachment 下載，避免同源 XSS / iframe sandbox 逃逸
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    const lower = filePath.toLowerCase();
    const isMedia = /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|m4v|mov|webm|mp3|wav|m4a|aac|ogg|amr)$/.test(lower);
    if (!isMedia) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));

// SPA fallback：將子路徑導回對應前端的 index.html，讓 React Router 接手
app.get('/admin/*', (req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'), (err) => err && next(err));
});
app.get('/liff/*', (req, res, next) => {
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
// 2) bootstrap admin_* 表（idempotent，production 缺 ADMIN_BOOTSTRAP_PASSWORD 時會跳過 user seed）
// 3) listen
(async () => {
  try {
    assertSecretConfigured();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
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
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`DAOS Server running on port ${PORT}`);
  });
})();
