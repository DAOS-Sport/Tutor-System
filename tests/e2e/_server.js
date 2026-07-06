/**
 * 最小整合測試伺服器（Route-Lock 驗收專用）。
 *
 * 目的：以「真實 route 檔 + 真實 middleware + 真實 DB」啟一個乾淨的 Express，
 * 但「不」啟 cron / websocket / bootstrap，避免在共用 dev DB 上重複觸發排程與
 * 背景寫入（正式 server/index.js 會全部啟動）。這讓 R9 / R3 / R4 的「修前失敗、
 * 修後通過」證據可重現、無副作用。
 *
 * 用法：TEST_PORT=3100 node tests/e2e/_server.js   （前景阻塞；由測試腳本以子行程管理）
 * 只掛驗收所需的兩個 mount：/api/venues（R9）與 /api/enrollments（R3/R4）。
 */
const path = require('path');
const SERVER = path.join(__dirname, '..', '..', 'server');
const express = require(path.join(SERVER, 'node_modules', 'express'));

const app = express();
app.use(express.json({ limit: '10mb' }));

// 與 index.js 相同：真實 route 檔（含各自的 auth middleware 與 DB 存取）
app.use('/api/venues', require(path.join(SERVER, 'routes', 'venues')));
app.use('/api/enrollments', require(path.join(SERVER, 'routes', 'enrollments')));

// 與 index.js 相同的乾淨 JSON 錯誤處理
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.TEST_PORT || 3100;
app.listen(PORT, '0.0.0.0', () => console.log(`[_server] route-lock test harness on :${PORT}`));
