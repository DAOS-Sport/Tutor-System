import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import RequireAuth from './components/RequireAuth';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import StaffPage from './pages/StaffPage';
import CoachesRedirect from './pages/CoachesRedirect';
import VenuesPage from './pages/VenuesPage';
import CourseIntrosPage from './pages/CourseIntrosPage';
import ReconcilePage from './pages/ReconcilePage';
import EnrollmentsPage from './pages/EnrollmentsPage';
import ManualEnrollPage from './pages/ManualEnrollPage';
import RefundPage from './pages/RefundPage';
import SessionsPage from './pages/SessionsPage';
import CheckinPage from './pages/CheckinPage';
import RevivePage from './pages/RevivePage';
import ManualDeductionPage from './pages/ManualDeductionPage';
import ChatLogsPage from './pages/ChatLogsPage';
import AlertsPage from './pages/AlertsPage';
import KeywordsPage from './pages/KeywordsPage';
import TagsPage from './pages/TagsPage';
import CoachEvalPage from './pages/CoachEvalPage';
import EvalThresholdPage from './pages/EvalThresholdPage';
import CoachIntrosReviewPage from './pages/CoachIntrosReviewPage';
import PromotionsPage from './pages/PromotionsPage';
import PromotionsActivePage from './pages/PromotionsActivePage';
import MgmStatsPage from './pages/MgmStatsPage';
import TransfersReviewPage from './pages/TransfersReviewPage';
import ReportsPage from './pages/ReportsPage';
import SopPage from './pages/SopPage';
import CourseTypesPage from './pages/CourseTypesPage';
import GroupOrdersPage from './pages/GroupOrdersPage';
import RagicStatusPage from './pages/RagicStatusPage';
import RagicStagingPage from './pages/RagicStagingPage';
import RagicZ03Page from './pages/RagicZ03Page';
import CustomerParentsPage from './pages/CustomerParentsPage';
import CustomerStudentsPage from './pages/CustomerStudentsPage';
import MockBanner from './components/MockBanner';

// 後台登入角色須與 server/middlewares/adminAuth.js 的共用裁判一致。
// manager 仍由 API 依 venue_ids 限制可見場館，並非取得 admin 全館權限。
const ALL = ['admin', 'manager', 'staff'];

export default function App() {
  return (
    <>
    <MockBanner />
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth roles={ALL}><AppLayout /></RequireAuth>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/reports"   element={<RequireAuth roles={['admin', 'manager']}><ReportsPage /></RequireAuth>} />

        {/* 系統設定（admin only） */}
        <Route path="/settings"      element={<RequireAuth roles={['admin']}><SettingsPage /></RequireAuth>} />
        <Route path="/staff"         element={<RequireAuth roles={['admin']}><StaffPage /></RequireAuth>} />
        {/* Task #91：F-C-Admin 已合併進員工帳號管理，舊路徑保留 redirect + toast */}
        <Route path="/coaches"       element={<CoachesRedirect />} />
        <Route path="/venues"        element={<RequireAuth roles={['admin']}><VenuesPage /></RequireAuth>} />
        <Route path="/course-intros" element={<RequireAuth roles={['admin', 'manager']}><CourseIntrosPage /></RequireAuth>} />
        <Route path="/course-types"  element={<RequireAuth roles={['admin']}><CourseTypesPage /></RequireAuth>} />
        <Route path="/group-orders"  element={<RequireAuth roles={['admin', 'manager', 'staff']}><GroupOrdersPage /></RequireAuth>} />
        <Route path="/ragic-status"  element={<RequireAuth roles={['admin']}><RagicStatusPage /></RequireAuth>} />
        <Route path="/ragic-staging" element={<RequireAuth roles={['admin']}><RagicStagingPage /></RequireAuth>} />
        <Route path="/ragic-z03"     element={<RequireAuth roles={['admin', 'manager', 'staff']}><RagicZ03Page /></RequireAuth>} />

        {/* 客戶資料管理（Z01 家長&學員關係 / Z02 學員資料含購買紀錄） */}
        <Route path="/customer-parents"  element={<RequireAuth roles={ALL}><CustomerParentsPage /></RequireAuth>} />
        <Route path="/customer-students" element={<RequireAuth roles={ALL}><CustomerStudentsPage /></RequireAuth>} />

        {/* 報名與對帳 */}
        <Route path="/manual-enroll" element={<RequireAuth roles={ALL}><ManualEnrollPage /></RequireAuth>} />
        <Route path="/reconcile"   element={<RequireAuth roles={['admin', 'manager', 'staff']}><ReconcilePage /></RequireAuth>} />
        <Route path="/enrollments" element={<RequireAuth roles={ALL}><EnrollmentsPage /></RequireAuth>} />
        <Route path="/refund"      element={<RequireAuth roles={['admin', 'manager']}><RefundPage /></RequireAuth>} />
        <Route path="/transfers"   element={<RequireAuth roles={['admin', 'manager']}><TransfersReviewPage /></RequireAuth>} />

        {/* 場館營運 */}
        <Route path="/sessions" element={<RequireAuth roles={ALL}><SessionsPage /></RequireAuth>} />
        <Route path="/checkin"  element={<RequireAuth roles={ALL}><CheckinPage /></RequireAuth>} />
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
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </>
  );
}
