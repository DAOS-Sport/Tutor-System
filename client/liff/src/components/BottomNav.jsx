import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { usePendingPayments } from '../context/PendingPaymentsContext';

const PARENT_TABS = [
  { to: '/',           label: '首頁',     end: true,  icon: HomeIcon },
  { to: '/my-courses', label: '我的課程', end: false, icon: BookIcon },
  // 聊天功能尚未上線：先反灰、不可點進，標示「敬請期待」。
  { to: '/chat',       label: '聊天',     end: false, icon: ChatIcon, comingSoon: true },
  { to: '/profile',    label: '個人',     end: false, icon: UserIcon },
];

// 教練端聊天功能已完整關閉（含路由封鎖，見 App.jsx），底部導覽不再顯示此分頁。
// 五個分頁：報名記錄從首頁的「學生報名狀態」預覽獨立出來（原本只看得到前 5 筆），
// 「授課記錄」把原本模稜兩可的「記錄」講清楚——它是課後填的授課內容，不是報名記錄。
const COACH_TABS = [
  { to: '/coach',          label: '首頁',     end: true,  icon: TodayIcon },
  { to: '/coach/orders',   label: '報名記錄', end: false, icon: ClipboardIcon },
  { to: '/coach/schedule', label: '排課',     end: false, icon: CalendarIcon },
  { to: '/coach/history',  label: '授課記錄', end: false, icon: UsersIcon },
  { to: '/coach/profile',  label: '個人',     end: false, icon: UserIcon },
];

const COL_MAP = { 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' };

export default function BottomNav() {
  const { role } = useAuth();
  const toast = useToast();
  const { count: pendingPaymentCount } = usePendingPayments();
  const tabs = role === 'coach' ? COACH_TABS : PARENT_TABS;
  const cols = COL_MAP[tabs.length] || 'grid-cols-4';

  return (
    <nav className="shrink-0 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]">
      <ul className={`grid ${cols}`}>
        {tabs.map(({ to, label, end, icon: Icon, comingSoon }) => {
          // 「我的課程」右上角紅色數字：待家長填寫/送出轉帳資料的訂單數（僅家長端）。
          const badge = role === 'parent' && to === '/my-courses' ? pendingPaymentCount : 0;
          return (
          <li key={to}>
            {comingSoon ? (
              // 未上線：反灰、不可導頁，點擊提示「敬請期待」，並在右上角標示。
              <button
                type="button"
                aria-disabled="true"
                onClick={() => toast.info('聊天功能即將上線，敬請期待 🙌')}
                className="relative flex w-full flex-col items-center justify-center gap-1 py-3 text-xs text-gray-300"
              >
                <Icon active={false} />
                <span className="whitespace-nowrap font-medium">{label}</span>
                <span className="pointer-events-none absolute right-1 top-1 rounded-full bg-brand-amber/15 px-1 text-[8px] font-bold leading-[1.5] text-brand-amber">敬請期待</span>
              </button>
            ) : (
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  `relative flex flex-col items-center justify-center gap-1 py-3 text-xs ${
                    isActive ? 'text-brand-teal' : 'text-gray-500'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon active={isActive} />
                    {/* 教練端「報名記錄／授課記錄」是四個字，390px 五欄下每欄 78px、
                        四字 12px 約 48px 還有餘裕；nowrap 是防它被壓成兩行。 */}
                    <span className="whitespace-nowrap font-medium">{label}</span>
                    {badge > 0 && (
                      <span
                        aria-label={`${badge} 筆待上傳付款資料`}
                        className="pointer-events-none absolute right-[18%] top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-error px-1 text-[10px] font-bold leading-none text-white"
                      >
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            )}
          </li>
          );
        })}
      </ul>
    </nav>
  );
}

function HomeIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 2}>
      <path d="M3 11l9-7 9 7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 10v10h14V10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function BookIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 2}>
      <path d="M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2V5z" strokeLinejoin="round" />
      <path d="M8 7h8M8 11h8M8 15h5" strokeLinecap="round" />
    </svg>
  );
}
function ChatIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 2}>
      <path d="M21 12a8 8 0 11-3.2-6.4L21 4l-1 4.8A7.96 7.96 0 0121 12z" strokeLinejoin="round" />
    </svg>
  );
}
function UserIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 2}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-7 8-7s8 3 8 7" strokeLinecap="round" />
    </svg>
  );
}
function CalendarIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 2}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}
function UsersIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 2}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2 20c0-3 3-5 7-5s7 2 7 5" strokeLinecap="round" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M15 14c3 0 7 1.5 7 4" strokeLinecap="round" />
    </svg>
  );
}
// 報名記錄：夾板＝一份名單。刻意與 UsersIcon（授課記錄，畫的是人）分開，
// 兩個分頁相鄰，圖示若都是人形在小尺寸下分不出來。
// 註：這些 icon 必須用 function 宣告——COACH_TABS 在檔案上方就引用它們，
// 靠 hoisting 才不會炸；寫成 const 會是 TDZ ReferenceError。
// 教練端第一個分頁：那一頁的內容是「今日課程」，不是一般意義的首頁，
// 所以用日曆而不是房子。**不要改 HomeIcon** —— 那支是家長端 `/` 在用的，
// 兩邊共用一份，動它會連家長首頁一起變。
function TodayIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 2}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
      {/* 今天：日曆格子裡填一個實心方塊，與隔壁純線條的「排課」日曆區分開 */}
      <rect x="7" y="13" width="4.5" height="4" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function ClipboardIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 2}>
      <path d="M9 4h6v3H9z" strokeLinejoin="round" />
      <path d="M9 5.5H6.5A1.5 1.5 0 005 7v12.5A1.5 1.5 0 006.5 21h11a1.5 1.5 0 001.5-1.5V7a1.5 1.5 0 00-1.5-1.5H15" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 11.5h7M8.5 15.5h4.5" strokeLinecap="round" />
    </svg>
  );
}
