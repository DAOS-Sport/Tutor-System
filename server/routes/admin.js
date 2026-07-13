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
router.use('/coaches',       require('./admin/coaches'));   // F-C-Admin (Task #32)
router.use('/venues',        require('./admin/venues'));
router.use('/settings',      require('./admin/settings'));
router.use('/course-intros', require('./admin/courseIntros'));
router.use('/checkouts',     require('./admin/checkouts'));
router.use('/enrollments',   require('./admin/enrollments'));
router.use('/sessions',      require('./admin/sessions'));
router.use('/manual-deductions', require('./admin/manualDeductions')); // F-R02 手動扣課（非 F-M05 扣課復活）
router.use('/checkins',      require('./admin/checkins'));   // Task #60
router.use('/chat',          require('./admin/chat'));
router.use('/periods',       require('./admin/periods'));
router.use('/learn',         require('./admin/learn'));   // F-A08 / F-M09 / F-A09 / F-C06
router.use('/promotions',    require('./admin/promotions')); // F-M07 / F-A05 / F-R05
router.use('/mgm-stats',     require('./admin/mgmStats'));   // F-M10
router.use('/transfers',     require('./admin/transfers'));  // F-M04
router.use('/reports',       require('./admin/reports'));    // F-M01
router.use('/uploads',       require('./admin/uploads'));    // Task #39 發票上傳
router.use('/course-types',  require('./admin/courseTypes')); // 課程需求管理
router.use('/group-orders',  require('./admin/groupOrders')); // U6 團購審核
router.use('/ragic-status',  require('./admin/ragicStatus')); // Task #65 Ragic 健康檢查
router.use('/ragic-staging', require('./admin/ragicStaging')); // Task #66 Ragic 待審核區
router.use('/ragic-z03',     require('./admin/ragicZ03'));     // Z03 舊系統壞姓名人工整理表
router.use('/customer-parents',  require('./admin/customerParents'));  // 客戶資料管理 Z01 家長&學員關係
router.use('/customer-students', require('./admin/customerStudents')); // 客戶資料管理 Z02 學員資料（含購買紀錄）

// 兜底：呼叫到沒實作的路徑時，明確回 404 而不是被前面的 401 吞掉
router.all('*', (req, res) => {
  res.status(404).json({ error: 'admin endpoint not found', path: req.path });
});

module.exports = router;
