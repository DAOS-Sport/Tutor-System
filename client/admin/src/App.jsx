import React, { Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import RequireAuth from './components/RequireAuth';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import CoachesRedirect from './pages/CoachesRedirect';
import MockBanner from './components/MockBanner';
import { BACKOFFICE_ROLES } from './constants/roles.js';
// 路由層級切分（#15 第 3 步）：登入頁與登入後第一屏（儀表板）維持同步載入，
// 其餘頁面各自成 chunk，第一次進入時才下載。lazyPage 會處理「部署後舊 chunk 不見」
// 的情況（重試一次、再不行重新整理一次），見 client/shared/lazyPage.jsx。
import { lazyPage, PageLoading } from '../../shared/lazyPage.jsx';

const SettingsPage = lazyPage(() => import('./pages/SettingsPage'));
const StaffPage = lazyPage(() => import('./pages/StaffPage'));
const RolePermissionsPage = lazyPage(() => import('./pages/RolePermissionsPage'));
const VenuesPage = lazyPage(() => import('./pages/VenuesPage'));
const CourseIntrosPage = lazyPage(() => import('./pages/CourseIntrosPage'));
const ReconcilePage = lazyPage(() => import('./pages/ReconcilePage'));
const EnrollmentsPage = lazyPage(() => import('./pages/EnrollmentsPage'));
const ManualEnrollPage = lazyPage(() => import('./pages/ManualEnrollPage'));
const RefundPage = lazyPage(() => import('./pages/RefundPage'));
const SessionsPage = lazyPage(() => import('./pages/SessionsPage'));
const CheckinPage = lazyPage(() => import('./pages/CheckinPage'));
const CheckinModesPage = lazyPage(() => import('./pages/CheckinModesPage'));
const RevivePage = lazyPage(() => import('./pages/RevivePage'));
const ManualDeductionPage = lazyPage(() => import('./pages/ManualDeductionPage'));
const ChatLogsPage = lazyPage(() => import('./pages/ChatLogsPage'));
const AlertsPage = lazyPage(() => import('./pages/AlertsPage'));
const KeywordsPage = lazyPage(() => import('./pages/KeywordsPage'));
const TagsPage = lazyPage(() => import('./pages/TagsPage'));
const CoachEvalPage = lazyPage(() => import('./pages/CoachEvalPage'));
const EvalThresholdPage = lazyPage(() => import('./pages/EvalThresholdPage'));
const CoachIntrosReviewPage = lazyPage(() => import('./pages/CoachIntrosReviewPage'));
const PromotionsPage = lazyPage(() => import('./pages/PromotionsPage'));
const PromotionsActivePage = lazyPage(() => import('./pages/PromotionsActivePage'));
const MgmStatsPage = lazyPage(() => import('./pages/MgmStatsPage'));
const TransfersReviewPage = lazyPage(() => import('./pages/TransfersReviewPage'));
const ReportsPage = lazyPage(() => import('./pages/ReportsPage'));
const SopPage = lazyPage(() => import('./pages/SopPage'));
const CounterManualPage = lazyPage(() => import('./pages/CounterManualPage'));
const CourseTypesPage = lazyPage(() => import('./pages/CourseTypesPage'));
const GroupOrdersPage = lazyPage(() => import('./pages/GroupOrdersPage'));
const RagicStatusPage = lazyPage(() => import('./pages/RagicStatusPage'));
const RagicStagingPage = lazyPage(() => import('./pages/RagicStagingPage'));
const RagicZ03Page = lazyPage(() => import('./pages/RagicZ03Page'));
const CustomerParentsPage = lazyPage(() => import('./pages/CustomerParentsPage'));
const CustomerStudentsPage = lazyPage(() => import('./pages/CustomerStudentsPage'));

// 後台登入角色須與 server/middlewares/adminAuth.js 的共用裁判一致。
// manager 仍由 API 依 venue_ids 限制可見場館，並非取得 admin 全館權限。
//
// 由 ROLES 推導，不要手寫。原本寫死成三個、漏了 lifeguard，而 RequireAuth
// 在權限還沒載到時就是退回這個陣列判定 —— 於是救生員每次重新整理都會先閃
// 一次「沒有權限存取此頁面」；權限 API 只要失敗一次（載不到就不會再重試），
// 他就被永久鎖在整個後台外面。/sessions /checkin /checkin-modes 三頁也吃
// 這個常數，正好是救生員的主要工作畫面。
const ALL = BACKOFFICE_ROLES;

export default function App() {
  return (
    <>
    <MockBanner />
    {/* 外層後備：AppLayout 內另有一層（換頁時保住側邊欄），這層接住 layout 以外的情況。 */}
    <Suspense fallback={<PageLoading />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth roles={ALL}><AppLayout /></RequireAuth>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/reports"   element={<RequireAuth roles={['admin', 'manager']}><ReportsPage /></RequireAuth>} />

        {/* 系統設定（admin only） */}
        <Route path="/settings"      element={<RequireAuth roles={['admin']}><SettingsPage /></RequireAuth>} />
        <Route path="/staff"         element={<RequireAuth roles={['admin']}><StaffPage /></RequireAuth>} />
        <Route path="/role-permissions" element={<RequireAuth roles={['admin']}><RolePermissionsPage /></RequireAuth>} />
        {/* Task #91：F-C-Admin 已合併進員工帳號管理，舊路徑保留 redirect + toast */}
        <Route path="/coaches"       element={<CoachesRedirect />} />
        <Route path="/venues"        element={<RequireAuth roles={['admin']}><VenuesPage /></RequireAuth>} />
        <Route path="/course-intros" element={<RequireAuth roles={['admin', 'manager']}><CourseIntrosPage /></RequireAuth>} />
        <Route path="/course-types"  element={<RequireAuth roles={['admin']}><CourseTypesPage /></RequireAuth>} />
        <Route path="/group-orders"  element={<RequireAuth roles={['admin', 'manager', 'staff']}><GroupOrdersPage /></RequireAuth>} />
        <Route path="/ragic-status"  element={<RequireAuth roles={['admin']}><RagicStatusPage /></RequireAuth>} />
        <Route path="/ragic-staging" element={<RequireAuth roles={['admin']} action="ragic-status:staging-review"><RagicStagingPage /></RequireAuth>} />
        <Route path="/ragic-z03"     element={<RequireAuth roles={['admin', 'manager', 'staff']}><RagicZ03Page /></RequireAuth>} />

        {/* 客戶資料管理（Z01 家長&學員關係 / Z02 學員資料含購買紀錄） */}
        <Route path="/customer-parents"  element={<RequireAuth roles={ALL}><CustomerParentsPage /></RequireAuth>} />
        <Route path="/customer-students" element={<RequireAuth roles={ALL}><CustomerStudentsPage /></RequireAuth>} />

        {/* 報名與對帳 */}
        <Route path="/manual-enroll" element={<RequireAuth roles={ALL}><ManualEnrollPage /></RequireAuth>} />
        <Route path="/reconcile"   element={<RequireAuth roles={['admin', 'manager', 'staff']}><ReconcilePage /></RequireAuth>} />
        <Route path="/enrollments" element={<RequireAuth roles={ALL}><EnrollmentsPage /></RequireAuth>} />
        <Route path="/refund"      element={<RequireAuth roles={['admin', 'manager', 'staff']}><RefundPage /></RequireAuth>} />
        <Route path="/transfers"   element={<RequireAuth roles={['admin', 'manager']}><TransfersReviewPage /></RequireAuth>} />

        {/* 場館營運 */}
        <Route path="/sessions" element={<RequireAuth roles={ALL}><SessionsPage /></RequireAuth>} />
        <Route path="/checkin"  element={<RequireAuth roles={ALL}><CheckinPage /></RequireAuth>} />
        <Route path="/checkin-modes" element={<RequireAuth roles={ALL}><CheckinModesPage /></RequireAuth>} />
        <Route path="/manual-deduction" element={<RequireAuth roles={['admin', 'manager', 'staff']}><ManualDeductionPage /></RequireAuth>} />
        <Route path="/revive"   element={<RequireAuth roles={['admin', 'manager', 'staff']}><RevivePage /></RequireAuth>} />

        {/* 聊天監察（Phase 4） */}
        <Route path="/chat-logs" element={<RequireAuth roles={['admin', 'manager']}><ChatLogsPage /></RequireAuth>} />
        <Route path="/alerts"    element={<RequireAuth roles={['admin', 'manager']}><AlertsPage /></RequireAuth>} />
        <Route path="/keywords"  element={<RequireAuth roles={['admin']}><KeywordsPage /></RequireAuth>} />

        {/* 行銷與優惠 (Phase 6) */}
        <Route path="/promotions"        element={<RequireAuth roles={['admin', 'manager']}><PromotionsPage /></RequireAuth>} />
        <Route path="/promotions-active" element={<RequireAuth roles={ALL}><PromotionsActivePage /></RequireAuth>} />
        <Route path="/mgm-stats"         element={<RequireAuth roles={['admin', 'manager']}><MgmStatsPage /></RequireAuth>} />

        {/* 學習歷程 (Phase 5) */}
        <Route path="/tags"                 element={<RequireAuth roles={['admin', 'manager']}><TagsPage /></RequireAuth>} />
        <Route path="/coach-eval"           element={<RequireAuth roles={['admin', 'manager']}><CoachEvalPage /></RequireAuth>} />
        <Route path="/eval-threshold"      element={<RequireAuth roles={['admin']}><EvalThresholdPage /></RequireAuth>} />
        <Route path="/coach-intros-review"  element={<RequireAuth roles={['admin', 'manager']}><CoachIntrosReviewPage /></RequireAuth>} />
        <Route path="/sop" element={<SopPage />} />
        <Route path="/counter-manual" element={<CounterManualPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </Suspense>
    </>
  );
}
