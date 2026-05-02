import React from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import BottomNav from './BottomNav';

const TAB_PATHS = ['/', '/my-courses', '/chat', '/profile'];

/**
 * 統一手機寬度容器：
 * - 永遠 max-w-[390px] 居中
 * - tab 頁顯示底部導覽列、內容下方留 BottomNav 高度
 * - flow 頁（報名流程／登入註冊）不顯示 BottomNav，並提供返回按鈕
 */
export default function AppLayout({ showBackButton = false, title }) {
  const location = useLocation();
  const navigate = useNavigate();
  const isTabPage = TAB_PATHS.includes(location.pathname);

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="relative mx-auto flex min-h-screen w-full max-w-[390px] flex-col bg-white shadow-sm">
        {(showBackButton || title) && (
          <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-gray-100 bg-white px-3">
            {showBackButton && (
              <button
                type="button"
                aria-label="返回"
                onClick={() => navigate(-1)}
                className="-ml-1 flex h-9 w-9 items-center justify-center rounded-full text-brand-primary active:bg-gray-100"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            {title && <h1 className="text-base font-bold text-brand-primary">{title}</h1>}
          </header>
        )}

        <main className={`flex-1 ${isTabPage ? 'pb-20' : 'pb-6'}`}>
          <Outlet />
        </main>

        {isTabPage && <BottomNav />}
      </div>
    </div>
  );
}
