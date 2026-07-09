import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import NewVersionBanner from './NewVersionBanner';
import ChangePasswordModal from './ChangePasswordModal';
import { useAuth } from '../context/AuthContext';

// 行政櫃檯（staff）仍用預設帳密登入時，強制引導一次修改帳密；系統管理員絕不觸發。
// 用 localStorage 記「已引導」，即使使用者按取消略過，同一瀏覽器對這個帳號也不會再跳出。
function forcedPromptKey(userId) {
  return `daos.admin.forcedPwdPrompted.${userId}`;
}

export default function AppLayout() {
  const { user, setUser } = useAuth();
  const [openForcedPwd, setOpenForcedPwd] = useState(false);

  useEffect(() => {
    if (!user || user.role !== 'staff' || !user.must_change_credentials) return;
    const key = forcedPromptKey(user.id);
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    setOpenForcedPwd(true);
  }, [user]);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-100">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <NewVersionBanner />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
      <ChangePasswordModal
        open={openForcedPwd}
        onClose={() => setOpenForcedPwd(false)}
        initialUsername={user?.username || ''}
        requireCredentialChange
        onSaved={(result) => {
          if (!user) return;
          setUser({
            ...user,
            username: result.username || user.username,
            must_change_credentials: false,
          });
        }}
      />
    </div>
  );
}
