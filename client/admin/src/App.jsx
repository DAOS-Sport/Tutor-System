import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import RequireAuth from './components/RequireAuth';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import StaffPage from './pages/StaffPage';
import VenuesPage from './pages/VenuesPage';
import CourseIntrosPage from './pages/CourseIntrosPage';
import ReconcilePage from './pages/ReconcilePage';
import EnrollmentsPage from './pages/EnrollmentsPage';
import RefundPage from './pages/RefundPage';
import SessionsPage from './pages/SessionsPage';
import CheckinPage from './pages/CheckinPage';
import RevivePage from './pages/RevivePage';
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

const ALL = ['admin', 'manager', 'staff'];

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth roles={ALL}><AppLayout /></RequireAuth>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />

        {/* 系統設定（admin only） */}
        <Route path="/settings"      element={<RequireAuth roles={['admin']}><SettingsPage /></RequireAuth>} />
        <Route path="/staff"         element={<RequireAuth roles={['admin']}><StaffPage /></RequireAuth>} />
        <Route path="/venues"        element={<RequireAuth roles={['admin']}><VenuesPage /></RequireAuth>} />
        <Route path="/course-intros" element={<RequireAuth roles={['admin', 'manager']}><CourseIntrosPage /></RequireAuth>} />

        {/* 報名與對帳 */}
        <Route path="/reconcile"   element={<RequireAuth roles={['admin', 'manager']}><ReconcilePage /></RequireAuth>} />
        <Route path="/enrollments" element={<RequireAuth roles={ALL}><EnrollmentsPage /></RequireAuth>} />
        <Route path="/refund"      element={<RequireAuth roles={['admin', 'manager']}><RefundPage /></RequireAuth>} />

        {/* 場館營運 */}
        <Route path="/sessions" element={<RequireAuth roles={ALL}><SessionsPage /></RequireAuth>} />
        <Route path="/checkin"  element={<RequireAuth roles={ALL}><CheckinPage /></RequireAuth>} />
        <Route path="/revive"   element={<RequireAuth roles={['admin', 'manager']}><RevivePage /></RequireAuth>} />

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
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
