import React from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';

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
import MyCoursesPage from './pages/MyCoursesPage';
import CourseDetailPage from './pages/CourseDetailPage';
import ChatListPage from './pages/ChatListPage';
import ChatRoomPage from './pages/ChatRoomPage';
import ProfilePage from './pages/ProfilePage';

import CoachTodayPage from './pages/CoachTodayPage';
import CoachScheduleWeekPage from './pages/CoachScheduleWeekPage';
import CoachProfilePage from './pages/CoachProfilePage';
import CoachSessionPage from './pages/CoachSessionPage';
import CoachStudentsPage from './pages/CoachStudentsPage';
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
  if (!isAuthed) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Outlet />;
}

function RequireParent() {
  const { role } = useAuth();
  if (role === 'parent') return <Outlet />;
  // 教練（或殘留的 coach session）走「家長 link」進來 → 不要踢去教練畫面，
  // 而是導去 /login 以同一個 LINE 帳號建立家長 session（家長情境會自動跑
  // parentLineLogin：有家長資料→直接登入；沒有→手機綁定/註冊）。這樣教練也能
  // 用家長端 link 當客戶使用，而不是被困在教練 App。
  return <Navigate to="/login" replace />;
}

function RequireCoach() {
  const { role } = useAuth();
  if (role === 'parent') return <Navigate to="/" replace />;
  // 未登入教練 → 導去教練專屬登入頁（web OAuth + 30天 portal token 續登），
  // 不可導去家長 /login（會觸發不適用的家長登入流程、或困在家長 LIFF）。
  if (role !== 'coach') return <Navigate to="/coach-portal" replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
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
                <Route path="/coach/students" element={<CoachStudentsPage />} />
                <Route path="/coach/chat" element={<ChatListPage />} />
                <Route path="/coach/profile" element={<CoachProfilePage />} />
              </Route>
              <Route element={<AppLayout showBackButton title="授課入口" />}>
                <Route path="/coach/session/:id" element={<CoachSessionPage />} />
              </Route>
              {/* 課前規劃 / 授課記錄 (Phase 5) */}
              <Route path="/coach/plan/:periodId" element={<LessonPlanFormPage />} />
              <Route path="/coach/record/:sessionId" element={<SessionRecordFormPage />} />
              <Route path="/coach/chat/:roomId" element={<ChatRoomPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
