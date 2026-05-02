require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { initWebSocket } = require('./services/websocket');
const { initCronJobs } = require('./cron');

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

// ── WebSocket (聊天室) ───────────────────────
initWebSocket(server);

// ── Cron Jobs ───────────────────────────────
initCronJobs();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`DAOS Server running on port ${PORT}`);
});
