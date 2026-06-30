import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const PARENT_TABS = [
  { to: '/',           label: '首頁',     end: true,  icon: HomeIcon },
  { to: '/my-courses', label: '我的課程', end: false, icon: BookIcon },
  // 聊天功能尚未上線：先反灰、不可點進，標示「敬請期待」。
  { to: '/chat',       label: '聊天',     end: false, icon: ChatIcon, comingSoon: true },
  { to: '/profile',    label: '個人',     end: false, icon: UserIcon },
];

const COACH_TABS = [
  { to: '/coach',          label: '今日',   end: true,  icon: HomeIcon },
  { to: '/coach/schedule', label: '排課',   end: false, icon: CalendarIcon },
  { to: '/coach/students', label: '學員',   end: false, icon: UsersIcon },
  { to: '/coach/chat',     label: '聊天',   end: false, icon: ChatIcon },
  { to: '/coach/profile',  label: '個人',   end: false, icon: UserIcon },
];

const COL_MAP = { 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' };

export default function BottomNav() {
  const { role } = useAuth();
  const toast = useToast();
  const tabs = role === 'coach' ? COACH_TABS : PARENT_TABS;
  const cols = COL_MAP[tabs.length] || 'grid-cols-4';

  return (
    <nav className="shrink-0 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]">
      <ul className={`grid ${cols}`}>
        {tabs.map(({ to, label, end, icon: Icon, comingSoon }) => (
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
                <span className="font-medium">{label}</span>
                <span className="pointer-events-none absolute right-1 top-1 rounded-full bg-brand-amber/15 px-1 text-[8px] font-bold leading-[1.5] text-brand-amber">敬請期待</span>
              </button>
            ) : (
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex flex-col items-center justify-center gap-1 py-3 text-xs ${
                    isActive ? 'text-brand-teal' : 'text-gray-500'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon active={isActive} />
                    <span className="font-medium">{label}</span>
                  </>
                )}
              </NavLink>
            )}
          </li>
        ))}
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
