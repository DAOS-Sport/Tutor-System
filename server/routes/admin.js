/**
 * /api/admin/* 入口：把子路由 mount 起來，取代原本的統一 501 stub。
 *
 * 路由分布（對應 client/admin/src/api/*.js）：
 *   /auth          → routes/admin/auth.js          （POST /login，回 JWT）
 *   /staff         → routes/admin/staff.js         （F-A02）
 *   /venues        → routes/admin/venues.js        （F-A03）
 *   /settings      → routes/admin/settings.js      （F-A01）
 *   /course-intros → routes/admin/courseIntros.js  （F-A04）
 *   /enrollments   → routes/admin/enrollments.js   （F-M02 / F-R02 / F-R04）
 *   /sessions      → routes/admin/sessions.js      （F-R01 / F-R03 / F-M05）
 *
 * 任何子路由都要求 Bearer JWT（除了 /auth/login）。授權 middleware 在
 * server/middlewares/adminAuth.js。
 */
const express = require('express');
const router = express.Router();

router.use('/auth',          require('./admin/auth'));
router.use('/staff',         require('./admin/staff'));
router.use('/venues',        require('./admin/venues'));
router.use('/settings',      require('./admin/settings'));
router.use('/course-intros', require('./admin/courseIntros'));
router.use('/enrollments',   require('./admin/enrollments'));
router.use('/sessions',      require('./admin/sessions'));

// 兜底：呼叫到沒實作的路徑時，明確回 404 而不是被前面的 401 吞掉
router.all('*', (req, res) => {
  res.status(404).json({ error: 'admin endpoint not found', path: req.path });
});

module.exports = router;
