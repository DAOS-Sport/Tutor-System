import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// 每個項目的 roles 控制可見性。空陣列表示所有登入者皆可見。
const NAV_GROUPS = [
  {
    title: '營運總覽',
    items: [
      { to: '/dashboard', label: '今日總覽', roles: [] },
    ],
  },
  {
    title: '系統設定',
    items: [
      { to: '/settings',     label: '全域系統設定 (F-A01)', roles: ['admin'] },
      { to: '/staff',        label: '員工帳號管理 (F-A02)', roles: ['admin'] },
      { to: '/venues',       label: '場館設定 (F-A03)',     roles: ['admin'] },
      { to: '/course-intros', label: '課程介紹 (F-A04/F-M06)', roles: ['admin', 'manager'] },
    ],
  },
  {
    title: '報名與對帳',
    items: [
      { to: '/reconcile',   label: '待對帳清單 (F-M02)', roles: ['admin', 'manager'] },
      { to: '/enrollments', label: '所有報名 (F-R02)',   roles: ['admin', 'manager', 'staff'] },
      { to: '/refund',      label: '退課處理 (F-R04)',   roles: ['admin', 'manager'] },
    ],
  },
  {
    title: '場館營運',
    items: [
      { to: '/sessions',    label: '今日課程 (F-R01)',   roles: ['admin', 'manager', 'staff'] },
      { to: '/checkin',     label: '簽到驗證 (F-R03)',   roles: ['admin', 'manager', 'staff'] },
      { to: '/revive',      label: '退課復活 (F-M05)',   roles: ['admin', 'manager'] },
    ],
  },
  {
    title: '聊天監察',
    items: [
      { to: '/chat-logs', label: '聊天紀錄 (F-M03)', roles: ['admin', 'manager', 'staff'] },
      { to: '/alerts',    label: '關鍵字警示',       roles: ['admin', 'manager'] },
      { to: '/keywords',  label: '關鍵字管理 (F-A07)', roles: ['admin'] },
    ],
  },
];

function canSee(item, role) {
  if (!item.roles || item.roles.length === 0) return true;
  return item.roles.includes(role);
}

export default function Sidebar() {
  const { role } = useAuth();

  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-brand-primary text-white md:flex">
      <div className="flex h-16 items-center justify-center border-b border-white/10 px-4">
        <span className="text-lg font-bold tracking-wide">DAOS 後台</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_GROUPS.map((group) => {
          const visible = group.items.filter((it) => canSee(it, role));
          if (visible.length === 0) return null;
          return (
            <div key={group.title} className="mb-4">
              <div className="px-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-white/50">
                {group.title}
              </div>
              <ul className="space-y-1">
                {visible.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      className={({ isActive }) =>
                        `block rounded-md px-3 py-2 text-sm transition ${
                          isActive
                            ? 'bg-brand-teal font-bold text-white'
                            : 'text-white/85 hover:bg-white/10'
                        }`
                      }
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-white/10 px-4 py-3 text-[11px] text-white/50">
        v1.0 Phase 3 · mock 模式
      </div>
    </aside>
  );
}
