require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { initWebSocket } = require('./services/websocket');
const { initCronJobs } = require('./cron');
const { bootstrap: bootstrapAdmin } = require('./bootstrap/admin');
const { assertSecretConfigured } = require('./middlewares/adminAuth');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: process.env.LIFF_URL || '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes ──────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/venues',        require('./routes/venues'));
app.use('/api/coaches',       require('./routes/coaches'));
app.use('/api/parents',       require('./routes/parents'));
app.use('/api/students',      require('./routes/students'));
app.use('/api/courses',       require('./routes/courses'));
app.use('/api/slots',         require('./routes/slots'));        // coach_availability_slots
app.use('/api/sessions',      require('./routes/sessions'));     // course_sessions
app.use('/api/checkins',      require('./routes/checkins'));
app.use('/api/payments',      require('./routes/payments'));
app.use('/api/promotions',    require('./routes/promotions'));
app.use('/api/referrals',     require('./routes/referrals'));    // MGM
app.use('/api/transfers',     require('./routes/transfers'));
app.use('/api/refunds',       require('./routes/refunds'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/learn',         require('./routes/learn'));        // 學習歷程
app.use('/api/evaluations',   require('./routes/evaluations'));  // 期末評鑑
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/notifications', require('./routes/notifications'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Static frontends ────────────────────────
// Vite 會把 admin / liff 兩個前端 build 到 server/public/{admin,liff}
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/admin', express.static(path.join(PUBLIC_DIR, 'admin')));
app.use('/liff', express.static(path.join(PUBLIC_DIR, 'liff')));

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
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`DAOS Server running on port ${PORT}`);
  });
})();
