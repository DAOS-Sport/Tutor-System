/**
 * 後台頁面清單（F-A06 的縱軸）。
 *
 * 這份清單原本以 NAV_GROUPS 的形式寫死在 Sidebar.jsx 裡，其中的 roles 陣列
 * 就是現行的權限矩陣。抽出來的理由有兩個：
 *   1. 那張矩陣要變成可編輯的資料，不能繼續是程式碼
 *   2. 前端選單與後端閘門必須讀同一份 —— 否則會做出「藏起來但打得進去」的假權限
 *
 * defaultRoles 只是**初始值**，用來在第一次啟動時灌進 role_permissions。
 * 灌完之後權威就是資料表，改這裡不會影響已經存在的設定 ——
 * 那是刻意的：管理員在後台調過的東西，不該被下一次部署默默改回來。
 * 所以這裡的值等於「上線第一天的行為＝上線前的行為」，不代表政策。
 */
'use strict';

const ADMIN_RESOURCES = Object.freeze([
  // 【營運總覽】
  { key: 'dashboard',           group: '營運總覽',        path: '/dashboard',            label: '今日總覽',                        defaultRoles: [] },
  { key: 'reports',             group: '營運總覽',        path: '/reports',              label: '(F-M01) 營運報表',                defaultRoles: ['admin', 'manager'] },
  // 【系統設定】
  { key: 'settings',            group: '系統設定',        path: '/settings',             label: '(F-A01) 全域系統設定',              defaultRoles: ['admin'] },
  { key: 'staff',               group: '系統設定',        path: '/staff',                label: '(F-A02) 員工帳號管理',              defaultRoles: ['admin'] },
  { key: 'role-permissions',    group: '系統設定',        path: '/role-permissions',     label: '角色權限管理',              defaultRoles: ['admin'] },
  { key: 'venues',              group: '系統設定',        path: '/venues',               label: '(F-A03) 場館設定',                defaultRoles: ['admin'] },
  { key: 'course-intros',       group: '系統設定',        path: '/course-intros',        label: '(F-A04/F-M06) 課程介紹',          defaultRoles: ['admin', 'manager'] },
  { key: 'course-types',        group: '系統設定',        path: '/course-types',         label: '課程需求管理',                      defaultRoles: ['admin'] },
  { key: 'ragic-status',        group: '系統設定',        path: '/ragic-status',         label: 'Ragic 連線狀態',                  defaultRoles: ['admin'] },
  // 【客戶資料管理】
  { key: 'customer-parents',    group: '客戶資料管理',      path: '/customer-parents',     label: '(Z01) 家長 & 學員關係',             defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'customer-students',   group: '客戶資料管理',      path: '/customer-students',    label: '(Z02) 學員資料（含購買紀錄）',           defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'ragic-z03',           group: '客戶資料管理',      path: '/ragic-z03',            label: '(Z03) 舊系統資料整理',               defaultRoles: ['admin', 'manager', 'staff'] },
  // 【報名與對帳】
  { key: 'manual-enroll',       group: '報名與對帳',       path: '/manual-enroll',        label: '手動建檔',                        defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'reconcile',           group: '報名與對帳',       path: '/reconcile',            label: '(F-M02) 待對帳清單',               defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'enrollments',         group: '報名與對帳',       path: '/enrollments',          label: '(F-R02) 所有報名',                defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'group-orders',        group: '報名與對帳',       path: '/group-orders',         label: '團購審核',                        defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'refund',              group: '報名與對帳',       path: '/refund',               label: '(F-R04) 退課處理',                defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'transfers',           group: '報名與對帳',       path: '/transfers',            label: '(F-M04) 課程轉讓審核',              defaultRoles: ['admin', 'manager'] },
  // 【場館營運】
  { key: 'sessions',            group: '場館營運',        path: '/sessions',             label: '(F-R01) 上課紀錄查詢',              defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'checkin',             group: '場館營運',        path: '/checkin',              label: '(F-R03) 簽到驗證',                defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'checkin-modes',       group: '場館營運',        path: '/checkin-modes',        label: '簽到模式管理',                      defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'manual-deduction',    group: '場館營運',        path: '/manual-deduction',     label: '手動扣課',                        defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'revive',              group: '場館營運',        path: '/revive',               label: '(F-M05) 扣課復活',                defaultRoles: ['admin', 'manager', 'staff'] },
  // 【聊天監察】
  { key: 'chat-logs',           group: '聊天監察',        path: '/chat-logs',            label: '(F-M03) 聊天紀錄',                defaultRoles: ['admin', 'manager'] },
  { key: 'alerts',              group: '聊天監察',        path: '/alerts',               label: '關鍵字警示',                       defaultRoles: ['admin', 'manager'] },
  { key: 'keywords',            group: '聊天監察',        path: '/keywords',             label: '(F-A07) 關鍵字管理',               defaultRoles: ['admin'] },
  // 【行銷與優惠】
  { key: 'promotions',          group: '行銷與優惠',       path: '/promotions',           label: '(F-M07/F-A05) 優惠活動',          defaultRoles: ['admin', 'manager'] },
  { key: 'promotions-active',   group: '行銷與優惠',       path: '/promotions-active',    label: '(F-R05) 進行中優惠',               defaultRoles: ['admin', 'manager', 'staff'] },
  { key: 'mgm-stats',           group: '行銷與優惠',       path: '/mgm-stats',            label: '(F-M10) MGM 推薦統計',            defaultRoles: ['admin', 'manager'] },
  // 【學習歷程】
  { key: 'tags',                group: '學習歷程',        path: '/tags',                 label: '(F-A08) 標籤庫',                 defaultRoles: ['admin', 'manager'] },
  { key: 'coach-eval',          group: '學習歷程',        path: '/coach-eval',           label: '(F-M09) 教練考核',                defaultRoles: ['admin', 'manager'] },
  { key: 'eval-threshold',      group: '學習歷程',        path: '/eval-threshold',       label: '(F-A09) 考核門檻',                defaultRoles: ['admin'] },
  { key: 'coach-intros-review', group: '學習歷程',        path: '/coach-intros-review',  label: '(F-C06) 教練介紹送審',              defaultRoles: ['admin', 'manager'] },
  // 【說明文件】
  { key: 'sop',                 group: '說明文件',        path: '/sop',                  label: '系統操作 SOP',                    defaultRoles: [] },
  { key: 'counter-manual',      group: '說明文件',        path: '/counter-manual',       label: '櫃台手冊',                        defaultRoles: [] },
].map(Object.freeze));

const RESOURCE_KEYS = Object.freeze(ADMIN_RESOURCES.map((r) => r.key));
const RESOURCE_GROUPS = Object.freeze([...new Set(ADMIN_RESOURCES.map((r) => r.group))]);

function isResourceKey(key) {
  return RESOURCE_KEYS.includes(String(key || ''));
}

module.exports = { ADMIN_RESOURCES, RESOURCE_KEYS, RESOURCE_GROUPS, isResourceKey };
