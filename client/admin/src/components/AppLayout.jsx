import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
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
  // 手機的選單抽屜。狀態放在這裡而不是 Sidebar 內部，因為 Header 的漢堡鍵
  // 要開它、換頁要關它 —— 三個元件共用同一份狀態。
  const [navOpen, setNavOpen] = useState(false);
  const loc = useLocation();
  // 換頁自動關閉。少了這一行，點完選單項目抽屜會留在畫面上蓋住剛打開的頁面。
  useEffect(() => { setNavOpen(false); }, [loc.pathname]);

  useEffect(() => {
    if (!user || user.role !== 'staff' || !user.must_change_credentials) return;
    const key = forcedPromptKey(user.id);
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    setOpenForcedPwd(true);
  }, [user]);

  return (
    // h-[100dvh] 而不是 h-screen：iOS Safari 的 100vh 含收合中的網址列高度，
    // 而這裡又是 overflow-hidden，多出來的高度捲不到 —— 清單最後一列與
    // 底部按鈕會永久被網址列蓋住。
    <div className="flex h-[100dvh] overflow-hidden bg-gray-100">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header onOpenNav={() => setNavOpen(true)} />
        <NewVersionBanner />
        {/* 375px 螢幕上 p-6 兩邊就吃掉 48px。 */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
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
