'use strict';
// 路由清冊（#39）：家長／教練端 API 與後台 API 各一份，陣列順序就是掛載順序。
// require 包在函式裡，由 server/index.js 與 server/routes/admin.js 在原本掛載的位置依序呼叫，
// 所以每個路由模組載入的時機與先後都跟原本逐行 app.use／router.use 相同。新增路由加在這裡。

const API_ROUTES = [
  ['/api/auth', () => require('./routes/auth')],
  ['/api/venues', () => require('./routes/venues')],
  ['/api/coaches', () => require('./routes/coaches')],
  ['/api/coach-portal', () => require('./routes/coachPortal')], // 教練端 LINE OAuth 登入模組（與家長端分離）
  ['/api/parents', () => require('./routes/parents')],
  ['/api/family', () => require('./routes/family')], // 家庭帳號：家長端申請合併、退出
  ['/api/courses', () => require('./routes/courses')],
  ['/api/slots', () => require('./routes/slots')], // coach_availability_slots
  ['/api/sessions', () => require('./routes/sessions')], // course_sessions
  ['/api/checkins', () => require('./routes/checkins')],
  ['/api/promotions', () => require('./routes/promotions')],
  ['/api/enrollments', () => require('./routes/enrollments')], // F-S02 LIFF 報名建立 + promotion_usages
  ['/api/checkout', () => require('./routes/checkout')], // checkout 母單付款頁
  ['/api/group-orders', () => require('./routes/groupOrders')], // U6 團購（家長端）
  ['/api/uploads', () => require('./routes/uploads')], // U3 家長端匯款證明上傳
  ['/api/referrals', () => require('./routes/referrals')], // MGM
  ['/api/transfers', () => require('./routes/transfers')],
  ['/api/chat', () => require('./routes/chat')],
  ['/api/learn', () => require('./routes/learn')], // 學習歷程
  ['/api/evaluations', () => require('./routes/evaluations')], // 期末評鑑
  ['/api/admin', () => require('./routes/admin')],
  // U16 整合 API：場館現場的外部前端（救生台等）查當下課表。服務金鑰 + 場館綁定，唯讀。
  ['/api/integrations', () => require('./routes/integrations')],
  // 前端診斷回報：家長端畫面壞在送出之前時，唯一留得下證據的通道。
  ['/api/diagnostics', () => require('./routes/diagnostics')],
  ['/api/onboarding', () => require('./routes/onboarding')],
];

// 掛在 /api/admin 底下（server/routes/admin.js）。
const ADMIN_ROUTES = [
  ['/auth', () => require('./routes/admin/auth')],
  ['/staff', () => require('./routes/admin/staff')],
  ['/coaches', () => require('./routes/admin/coaches')], // F-C-Admin (Task #32)
  ['/venues', () => require('./routes/admin/venues')],
  ['/settings', () => require('./routes/admin/settings')],
  ['/course-intros', () => require('./routes/admin/courseIntros')],
  ['/checkouts', () => require('./routes/admin/checkouts')],
  ['/enrollments', () => require('./routes/admin/enrollments')],
  ['/sessions', () => require('./routes/admin/sessions')],
  ['/manual-deductions', () => require('./routes/admin/manualDeductions')], // F-R02 手動扣課（非 F-M05 扣課復活）
  ['/checkins', () => require('./routes/admin/checkins')], // Task #60
  ['/chat', () => require('./routes/admin/chat')],
  ['/periods', () => require('./routes/admin/periods')],
  ['/learn', () => require('./routes/admin/learn')], // F-A08 / F-M09 / F-A09 / F-C06
  ['/promotions', () => require('./routes/admin/promotions')], // F-M07 / F-A05 / F-R05
  ['/mgm-stats', () => require('./routes/admin/mgmStats')], // F-M10
  ['/transfers', () => require('./routes/admin/transfers')], // F-M04
  ['/reports', () => require('./routes/admin/reports')], // F-M01
  ['/uploads', () => require('./routes/admin/uploads')], // Task #39 發票上傳
  ['/role-permissions', () => require('./routes/admin/rolePermissions')], // F-A06 角色權限管理
  ['/pricing-zones', () => require('./routes/admin/pricingZones')], // F-A08 定價區（課程需求管理的分頁）
  ['/course-types', () => require('./routes/admin/courseTypes')], // 課程需求管理
  ['/group-orders', () => require('./routes/admin/groupOrders')], // U6 團購審核
  ['/ragic-status', () => require('./routes/admin/ragicStatus')], // Task #65 Ragic 健康檢查
  ['/ragic-timeline', () => require('./routes/admin/ragicTimeline')], // Read-only completed daily nodes.
  ['/ragic-staging', () => require('./routes/admin/ragicStaging')], // Task #66 Ragic 待審核區
  ['/ragic-z03', () => require('./routes/admin/ragicZ03')], // Z03 舊系統壞姓名人工整理表
  ['/customer-parents', () => require('./routes/admin/customerParents')], // 客戶資料管理 Z01 家長&學員關係
  ['/customer-students', () => require('./routes/admin/customerStudents')], // 客戶資料管理 Z02 學員資料（含購買紀錄）
  ['/families', () => require('./routes/admin/families')], // 家庭帳號（Z01 頁的家庭區塊與申請審核）
];

module.exports = { API_ROUTES, ADMIN_ROUTES };
