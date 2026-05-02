import React from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';

import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import HomePage from './pages/HomePage';
import VenueSelectPage from './pages/VenueSelectPage';
import CoachListPage from './pages/CoachListPage';
import EnrollmentPage from './pages/EnrollmentPage';
import EnrollmentSuccessPage from './pages/EnrollmentSuccessPage';
import MyCoursesPage from './pages/MyCoursesPage';
import ChatPage from './pages/ChatPage';
import ProfilePage from './pages/ProfilePage';

function RequireAuth() {
  const { isAuthed } = useAuth();
  const location = useLocation();
  if (!isAuthed) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <Outlet />;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          {/* 公開路由（登入 / 註冊）— 仍套用 mobile 容器但無 BottomNav */}
          <Route element={<AppLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
          </Route>

          {/* 需登入路由 */}
          <Route element={<RequireAuth />}>
            {/* Tab 頁：底部有 BottomNav */}
            <Route element={<AppLayout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/my-courses" element={<MyCoursesPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/profile" element={<ProfilePage />} />
            </Route>

            {/* 報名流程：頂部有返回按鈕 */}
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
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
