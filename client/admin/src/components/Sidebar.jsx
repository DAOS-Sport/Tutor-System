import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ragicStagingApi } from '../api/ragicStaging';

// 每個項目的 roles 控制可見性。空陣列表示所有登入者皆可見。
// 顯示格式為「(代碼) 中文」，無代碼者僅顯示中文。
const NAV_GROUPS = [
  {
    title: '營運總覽',
    items: [
      { to: '/dashboard', label: '今日總覽', roles: [] },
      { to: '/reports',   label: '(F-M01) 營運報表', roles: ['admin', 'manager'] },
    ],
  },
  {
    title: '系統設定',
    items: [
      { to: '/settings',      label: '(F-A01) 全域系統設定', roles: ['admin'] },
      { to: '/staff',         label: '(F-A02) 員工帳號管理', roles: ['admin'] },
      // Task #91：F-C-Admin 教練資料已合併進員工帳號管理，sidebar 入口下架
      { to: '/venues',        label: '(F-A03) 場館設定',     roles: ['admin'] },
      { to: '/course-intros', label: '(F-A04/F-M06) 課程介紹', roles: ['admin', 'manager'] },
      { to: '/course-types',  label: '課程需求管理',           roles: ['admin'] },
      { to: '/ragic-status',  label: 'Ragic 連線狀態',         roles: ['admin'] },
      { to: '/ragic-staging', label: 'Ragic 待審核',           roles: ['admin'], badgeKey: 'ragicStaging' },
    ],
  },
  {
    title: '報名與對帳',
    items: [
      { to: '/reconcile',   label: '(F-M02) 待對帳清單', roles: ['admin', 'manager', 'staff'] },
      { to: '/enrollments', label: '(F-R02) 所有報名',   roles: ['admin', 'manager', 'staff'] },
      { to: '/group-orders', label: '團購審核',          roles: ['admin', 'manager', 'staff'] },
      { to: '/refund',      label: '(F-R04) 退課處理',   roles: ['admin', 'manager'] },
      { to: '/transfers',   label: '(F-M04) 課程轉讓審核', roles: ['admin', 'manager'] },
    ],
  },
  {
    title: '場館營運',
    items: [
      { to: '/sessions', label: '(F-R01) 上課紀錄查詢', roles: ['admin', 'manager', 'staff'] },
      { to: '/checkin',  label: '(F-R03) 簽到驗證', roles: ['admin', 'manager', 'staff'] },
      { to: '/revive',   label: '(F-M05) 扣課復活', roles: ['admin', 'manager', 'staff'] },
    ],
  },
  {
    title: '聊天監察',
    items: [
      { to: '/chat-logs', label: '(F-M03) 聊天紀錄',   roles: ['admin', 'manager'] },
      { to: '/alerts',    label: '關鍵字警示',          roles: ['admin', 'manager'] },
      { to: '/keywords',  label: '(F-A07) 關鍵字管理', roles: ['admin'] },
    ],
  },
  {
    title: '行銷與優惠',
    items: [
      { to: '/promotions',         label: '(F-M07/F-A05) 優惠活動', roles: ['admin', 'manager'] },
      { to: '/promotions-active',  label: '(F-R05) 進行中優惠',     roles: ['admin', 'manager', 'staff'] },
      { to: '/mgm-stats',          label: '(F-M10) MGM 推薦統計',   roles: ['admin', 'manager'] },
    ],
  },
  {
    title: '學習歷程',
    items: [
      { to: '/tags',                label: '(F-A08) 標籤庫',         roles: ['admin', 'manager'] },
      { to: '/coach-eval',          label: '(F-M09) 教練考核',       roles: ['admin', 'manager'] },
      { to: '/eval-threshold',      label: '(F-A09) 考核門檻',       roles: ['admin'] },
      { to: '/coach-intros-review', label: '(F-C06) 教練介紹送審',   roles: ['admin', 'manager'] },
    ],
  },
  {
    title: '說明文件',
    items: [
      { to: '/sop', label: '系統操作 SOP', roles: [] },
    ],
  },
];

function canSee(item, role) {
  if (!item.roles || item.roles.length === 0) return true;
  return item.roles.includes(role);
}

export default function Sidebar() {
  const { role } = useAuth();
  const [badges, setBadges] = useState({ ragicStaging: 0 });

  useEffect(() => {
    if (role !== 'admin') return undefined;
    // Task #68：登入頁不要打 badge polling（避免登入前/後競態 + 無謂 401）
    if (typeof window !== 'undefined' && window.location.pathname.endsWith('/login')) {
      return undefined;
    }
    let cancelled = false;
    let failures = 0;
    let timer = null;
    let stopped = false;
    async function refresh() {
      if (stopped) return;
      try {
        const r = await ragicStagingApi.count();
        if (cancelled) return;
        failures = 0;
        setBadges((b) => ({ ...b, ragicStaging: r?.pending || 0 }));
      } catch {
        // Task #68：失敗 3 次後停止輪詢，避免在後端壞掉時持續刷錯誤
        failures += 1;
        if (failures >= 3) {
          stopped = true;
          if (timer) clearInterval(timer);
        }
      }
    }
    refresh();
    timer = setInterval(refresh, 60_000);
    // Task #68：onFocus 加 throttle，避免快速切 tab 時連發多次請求
    let lastFocusRefresh = 0;
    const onFocus = () => {
      if (stopped) return;
      const now = Date.now();
      if (now - lastFocusRefresh < 5_000) return;
      lastFocusRefresh = now;
      refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      stopped = true;
      if (timer) clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [role]);

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
                        `flex items-center justify-between rounded-md px-3 py-2 text-sm transition ${
                          isActive
                            ? 'bg-brand-teal font-bold text-white'
                            : 'text-white/85 hover:bg-white/10'
                        }`
                      }
                    >
                      <span>{item.label}</span>
                      {item.badgeKey && badges[item.badgeKey] > 0 ? (
                        <span className="ml-2 rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-brand-primary">
                          {badges[item.badgeKey]}
                        </span>
                      ) : null}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-white/10 px-4 py-3 text-[11px] text-white/50">
        v1.0 Phase 6
      </div>
    </aside>
  );
}
