import React from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { PendingPaymentsProvider } from './context/PendingPaymentsContext';
import MockBanner from './components/MockBanner';

import LoginPage from './pages/LoginPage';
import DemoLoginPage from './pages/DemoLoginPage';
import RegisterPage from './pages/RegisterPage';
import CoachPortalLoginPage from './pages/CoachPortalLoginPage';
import HomePage from './pages/HomePage';
import VenueSelectPage from './pages/VenueSelectPage';
import CoachListPage from './pages/CoachListPage';
import EnrollmentPage from './pages/EnrollmentPage';
import EnrollmentSuccessPage from './pages/EnrollmentSuccessPage';
import EnrollStatusPage from './pages/EnrollStatusPage';
import CheckoutPage from './pages/CheckoutPage';
import MyCoursesPage from './pages/MyCoursesPage';
import CourseDetailPage from './pages/CourseDetailPage';
import ChatListPage from './pages/ChatListPage';
import ChatRoomPage from './pages/ChatRoomPage';
import ProfilePage from './pages/ProfilePage';

import CoachTodayPage from './pages/CoachTodayPage';
import CoachScheduleWeekPage from './pages/CoachScheduleWeekPage';
import CoachProfilePage from './pages/CoachProfilePage';
import CoachSessionPage from './pages/CoachSessionPage';
import CoachHistoryPage from './pages/CoachHistoryPage';
import LessonPlanFormPage from './pages/LessonPlanFormPage';
import SessionRecordFormPage from './pages/SessionRecordFormPage';
import LearningHistoryPage from './pages/LearningHistoryPage';
import EvaluationFormPage from './pages/EvaluationFormPage';
import ReferralPage from './pages/ReferralPage';
import TransferRequestPage from './pages/TransferRequestPage';
import MyLessonsPage from './pages/MyLessonsPage';
import GroupCreatePage from './pages/GroupCreatePage';
import GroupJoinPage from './pages/GroupJoinPage';
import GroupStatusPage from './pages/GroupStatusPage';
import SlotBookingPage from './pages/SlotBookingPage';

function RequireAuth() {
  const { isAuthed } = useAuth();
  const location = useLocation();
  const isCoachRoute = /\/coach(\b|\/|$)/.test(location.pathname || '');
  if (!isAuthed) {
    return <Navigate to={isCoachRoute ? '/coach-portal' : '/login'} state={{ from: location }} replace />;
  }
  return <Outlet />;
}

function RequireParent() {
  const { role, parent } = useAuth();
  if (role === 'parent' && parent?.id) return <Outlet />;
  // 教練（或殘留的 coach session）走「家長 link」進來 → 不要踢去教練畫面，
  // 而是導去 /login 以同一個 LINE 帳號建立家長 session（家長情境會自動跑
  // parentLineLogin：有家長資料→直接登入；沒有→手機綁定/註冊）。這樣教練也能
  // 用家長端 link 當客戶使用，而不是被困在教練 App。
  return <Navigate to="/login" replace />;
}

function RequireCoach() {
  const { role } = useAuth();
  // 教練路由只接受 coach session。若同一個 LINE 目前殘留 parent session，
  // 也必須進教練專屬登入頁重新跑 coaches/H01 驗證，不可導回家長首頁。
  if (role !== 'coach') return <Navigate to="/coach-portal" replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <PendingPaymentsProvider>
        <MockBanner />
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/demo" element={<DemoLoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
          </Route>

          {/* 教練端 LINE OAuth 登入（與家長端分離，全屏無 layout） */}
          <Route path="/coach-portal" element={<CoachPortalLoginPage />} />

          {/* 公開：團購加入連結（免登入先看狀態 / 電話查詢；加入時才要求登入） */}
          <Route element={<AppLayout showBackButton title="加入團購" />}>
            <Route path="/group/join/:token" element={<GroupJoinPage />} />
          </Route>

          <Route element={<RequireAuth />}>
            {/* ── 家長分頁 ── */}
            <Route element={<RequireParent />}>
              <Route element={<AppLayout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/my-courses" element={<MyCoursesPage />} />
                <Route path="/chat" element={<ChatListPage />} />
                <Route path="/profile" element={<ProfilePage />} />
              </Route>
              {/* 上課記錄：自首頁進入的子頁，需返回鍵；同時保留底部導覽列（加入 TAB_PATHS） */}
              <Route element={<AppLayout showBackButton title="上課記錄" />}>
                <Route path="/my-lessons" element={<MyLessonsPage />} />
              </Route>
              <Route path="/chat/:roomId" element={<ChatRoomPage />} />
              <Route element={<AppLayout showBackButton title="選擇場館" />}>
                <Route path="/venue" element={<VenueSelectPage />} />
              </Route>
              <Route element={<AppLayout showBackButton title="選擇教練" />}>
                <Route path="/coaches" element={<CoachListPage />} />
              </Route>
              <Route element={<AppLayout showBackButton title="課程報名" />}>
                <Route path="/enroll" element={<EnrollmentPage />} />
              </Route>
              <Route element={<AppLayout title="報名完成" />}>
                <Route path="/enroll-success" element={<EnrollmentSuccessPage />} />
              </Route>
              {/* U10 報名狀態頁（送出後：繳款 / 上傳證明 / 等待櫃台確認） */}
              <Route element={<AppLayout showBackButton title="報名狀態" />}>
                <Route path="/enroll-status/:id" element={<EnrollStatusPage />} />
              </Route>
              <Route element={<AppLayout showBackButton title="付款資訊" />}>
                <Route path="/checkout/:checkoutId" element={<CheckoutPage />} />
              </Route>
              {/* U7 團購 */}
              <Route element={<AppLayout showBackButton title="發起團購" />}>
                <Route path="/group/new" element={<GroupCreatePage />} />
              </Route>
              <Route element={<AppLayout showBackButton title="團購狀態" />}>
                <Route path="/group/:id" element={<GroupStatusPage />} />
              </Route>
              <Route element={<AppLayout showBackButton title="課程詳情" />}>
                <Route path="/course/:id" element={<CourseDetailPage />} />
              </Route>
              {/* 學習歷程 / 期末評鑑 (Phase 5) */}
              <Route path="/history/:periodId" element={<LearningHistoryPage />} />
              <Route element={<AppLayout showBackButton title="選擇上課時間" />}>
                <Route path="/book-slot/:periodId" element={<SlotBookingPage />} />
              </Route>
              <Route path="/evaluation/:id" element={<EvaluationFormPage />} />
              {/* MGM 推薦連結 (Phase 6 下) */}
              <Route element={<AppLayout showBackButton title="邀請好友" />}>
                <Route path="/referral" element={<ReferralPage />} />
              </Route>
              <Route element={<AppLayout showBackButton title="課程轉讓" />}>
                <Route path="/transfer/new" element={<TransferRequestPage />} />
              </Route>
            </Route>

            {/* ── 教練分頁 ── */}
            <Route element={<RequireCoach />}>
              <Route element={<AppLayout />}>
                <Route path="/coach" element={<CoachTodayPage />} />
                <Route path="/coach/schedule" element={<CoachScheduleWeekPage />} />
                <Route path="/coach/history" element={<CoachHistoryPage />} />
                <Route path="/coach/profile" element={<CoachProfilePage />} />
              </Route>
              <Route element={<AppLayout showBackButton title="授課入口" />}>
                <Route path="/coach/session/:id" element={<CoachSessionPage />} />
              </Route>
              {/* 舊「學員」分頁已改為「授課記錄」；保留舊網址轉址避免書籤 404 */}
              <Route path="/coach/students" element={<Navigate to="/coach/history" replace />} />
              {/* 課前規劃 / 授課記錄 (Phase 5) */}
              <Route path="/coach/plan/:periodId" element={<LessonPlanFormPage />} />
              <Route path="/coach/record/:sessionId" element={<SessionRecordFormPage />} />
              {/* 教練端聊天功能已關閉：手動輸入舊網址一律導回「今日」，不渲染聊天頁面 */}
              <Route path="/coach/chat" element={<Navigate to="/coach" replace />} />
              <Route path="/coach/chat/:roomId" element={<Navigate to="/coach" replace />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </PendingPaymentsProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
