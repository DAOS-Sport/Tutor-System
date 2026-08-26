import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../context/PermissionContext';
import { USE_MOCK } from '../api/client';
// 能登入後台的角色。與 App.jsx 的 ALL 同一個來源 ——
// 兩邊各寫一份的話，放寬其中一邊（例如開放救生員）另一邊就會落後，
// 症狀是「路由進得去但選單沒有入口」，而那不會有人回報成 bug。
import { BACKOFFICE_ROLES } from '../constants/roles.js';

// 每個項目的 roles 控制可見性。空陣列表示所有登入者皆可見。
// 顯示格式為「(代碼) 中文」，無代碼者僅顯示中文。
const ALL = BACKOFFICE_ROLES;

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
      { to: '/role-permissions', label: '(F-A06) 角色權限管理', roles: ['admin'] },
      // Task #91：F-C-Admin 教練資料已合併進員工帳號管理，sidebar 入口下架
      { to: '/venues',        label: '(F-A03) 場館設定',     roles: ['admin'] },
      { to: '/course-intros', label: '(F-A04/F-M06) 課程介紹', roles: ['admin', 'manager'] },
      { to: '/course-types',  label: '課程需求管理',           roles: ['admin'] },
      { to: '/ragic-status',  label: 'Ragic 連線狀態',         roles: ['admin'] },
    ],
  },
  {
    title: '客戶資料管理',
    items: [
      { to: '/customer-parents',  label: '(Z01) 家長 & 學員關係',       roles: ALL },
      { to: '/customer-students', label: '(Z02) 學員資料（含購買紀錄）', roles: ALL },
      { to: '/ragic-z03',         label: '(Z03) 舊系統資料整理',        roles: ['admin', 'manager', 'staff'] },
    ],
  },
  {
    title: '報名與對帳',
    items: [
      { to: '/manual-enroll', label: '手動建檔',          roles: ALL },
      { to: '/reconcile',   label: '(F-M02) 待對帳清單', roles: ['admin', 'manager', 'staff'] },
      { to: '/enrollments', label: '(F-R02) 所有報名',   roles: ALL },
      { to: '/group-orders', label: '團購審核',          roles: ['admin', 'manager', 'staff'] },
      { to: '/refund',      label: '(F-R04) 退課處理',   roles: ['admin', 'manager', 'staff'] },
      { to: '/transfers',   label: '(F-M04) 課程轉讓審核', roles: ['admin', 'manager'] },
    ],
  },
  {
    title: '場館營運',
    items: [
      { to: '/sessions', label: '(F-R01) 上課紀錄查詢', roles: ALL },
      { to: '/checkin',  label: '(F-R03) 簽到驗證', roles: ALL },
      { to: '/checkin-modes', label: '簽到模式管理', roles: ALL },
      { to: '/manual-deduction', label: '手動扣課', roles: ['admin', 'manager', 'staff'] },
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
      { to: '/promotions-active',  label: '(F-R05) 進行中優惠',     roles: ALL },
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

// F-A06：選單依角色權限設定顯示。
// item.roles 只在「權限還沒載到」時當後備 —— 直接放行會讓非管理員在載入的
// 那半秒看到整份選單，那比慢半秒糟得多。
function canSee(item, role, allowed, can) {
  if (allowed === null) {
    if (!item.roles || item.roles.length === 0) return true;
    return item.roles.includes(role);
  }
  return can(item.to.replace(/^\//, ''));
}

/**
 * 側邊選單。桌機是固定的一欄，手機是從左側滑出的抽屜。
 *
 * 原本是 hidden ... md:flex —— 768px 以下整個消失，而全站沒有任何替代入口。
 * 桌機使用者不會發現，因為他們永遠在 md 以上。但救生員幾乎一定是用手機
 * （他們在池畔，不會坐在辦公桌前），登入後被導到 /dashboard 就再也去不了
 * 任何其他頁面 —— 包含他唯一要用的簽到頁 —— 除非手打網址。
 *
 * 開關用 hidden/flex 而不是 translate 滑入：實測 translate-x-0 進了 class 清單，
 * computed transform 卻仍是 -256px（Tailwind 的 translate 工具類沒有蓋過去）。
 * 滑入動畫只是好看，選單打不開是功能壞掉 —— 用原本 `hidden ... md:flex` 的
 * 同一套機制最穩，md: 的斷點覆蓋在整個專案裡到處都在用，行為是確定的。
 *
 * 同一個元件兩種型態，不維護兩份選單（維護兩份的話，遲早只有一份會被更新）。
 */
export default function Sidebar({ open = false, onClose }) {
  const { role } = useAuth();
  const { allowed, can } = usePermissions();

  return (
    <>
    {/* 手機才有的遮罩。點它關閉，這是行動裝置上大家預期的行為。 */}
    {open && (
      <div className="fixed inset-0 z-30 bg-black/40 md:hidden"
           onClick={onClose} aria-hidden="true" />
    )}
    <aside
      onClick={() => onClose && onClose()}
      className={`${open ? 'flex' : 'hidden'} fixed inset-y-0 left-0 z-40 w-64 shrink-0 flex-col overflow-y-auto bg-brand-primary text-white md:static md:z-auto md:flex`}>
      <div className="flex h-16 items-center justify-center border-b border-white/10 px-4">
        <span className="text-lg font-bold tracking-wide">DAOS 後台</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_GROUPS.map((group) => {
          const visible = group.items.filter((it) => canSee(it, role, allowed, can));
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
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-white/10 px-4 py-3 text-[11px] text-white/50">
        {USE_MOCK ? (
          <div className="mb-2 rounded bg-amber-500/90 px-2 py-1 text-center text-[11px] font-bold text-black">
            ⚠ MOCK 模式（假資料，未連真後端）
          </div>
        ) : null}
        v1.0 Phase 6
        <div className="mt-0.5 text-white/40">
          build {import.meta.env.VITE_BUILD_SHA || 'dev'}
          {import.meta.env.VITE_BUILD_TIME ? ` @ ${import.meta.env.VITE_BUILD_TIME}` : ''}
        </div>
      </div>
    </aside>
    </>
  );
}
