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
import ChatListPage from './pages/ChatListPage';
import ChatRoomPage from './pages/ChatRoomPage';
import ProfilePage from './pages/ProfilePage';

import CoachTodayPage from './pages/CoachTodayPage';
import CoachScheduleWeekPage from './pages/CoachScheduleWeekPage';
import CoachProfilePage from './pages/CoachProfilePage';
import CoachSessionPage from './pages/CoachSessionPage';
import CoachStudentsPage from './pages/CoachStudentsPage';

function RequireAuth() {
  const { isAuthed } = useAuth();
  const location = useLocation();
  if (!isAuthed) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Outlet />;
}

function RequireParent() {
  const { role } = useAuth();
  if (role === 'coach') return <Navigate to="/coach" replace />;
  if (role !== 'parent') return <Navigate to="/login" replace />;
  return <Outlet />;
}

function RequireCoach() {
  const { role } = useAuth();
  if (role === 'parent') return <Navigate to="/" replace />;
  if (role !== 'coach') return <Navigate to="/login" replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
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
              <Route path="/coach/chat/:roomId" element={<ChatRoomPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
