import React from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import BottomNav from './BottomNav';

const TAB_PATHS = [
  '/', '/my-courses', '/my-lessons', '/chat', '/profile',
  '/coach', '/coach/schedule', '/coach/students', '/coach/chat', '/coach/profile',
];

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
  const isCoachProfilePage = location.pathname === '/coach/profile';

  return (
    // 固定 App 殼：外層佔滿視窗高、置中 390 容器；內層為「動態視窗高(dvh)」的 flex 直欄，
    // 只有 <main> 會捲動 → header / BottomNav 釘住不隨內容跑（修 UX 跑位問題）。
    // 用 h-dvh（Tailwind 3.4 內建）避開行動裝置網址列收合造成的高度跳動。
    <div className="flex min-h-dvh justify-center bg-gray-100">
      <div
        className={`relative flex h-dvh w-full max-w-[390px] flex-col overflow-hidden bg-white ${
          isCoachProfilePage ? '' : 'shadow-sm'
        }`}
      >
        {(showBackButton || title) && (
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-100 bg-white px-3">
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

        <main className="flex-1 overflow-y-auto overscroll-contain">
          <Outlet />
        </main>

        {isTabPage && <BottomNav />}
      </div>
    </div>
  );
}
