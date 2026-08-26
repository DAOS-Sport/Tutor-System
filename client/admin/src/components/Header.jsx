import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { roleLabel } from '../utils/format';
import StatusBadge from './StatusBadge';
import ChangePasswordModal from './ChangePasswordModal';

const ROLE_TONE = { admin: 'primary', manager: 'teal', staff: 'gold' };

export default function Header({ onOpenNav }) {
  const { user, logout, setUser } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [openPwd, setOpenPwd] = useState(false);

  const onLogout = () => {
    logout();
    toast.info('已登出');
    nav('/login', { replace: true });
  };

  return (
    <header className="flex h-16 items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* 手機唯一的選單入口。44px 見方 —— 低於這個尺寸在手機上按不準，
            而救生員多半是濕手在池畔操作。 */}
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="開啟選單"
          className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 md:hidden"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="truncate text-sm text-gray-500">夢想體育學院 · 管理後台</div>
      </div>
      {/* shrink-0：不加的話這一整組會被標題擠壓，而按鈕裡的中文會折成兩行 ——
          實機上看到的是「個人 設定」「登 出」「系統管理 理員」三個都斷開，
          整條頂欄像壞掉。flex 預設不換行，折的是按鈕內部的文字。 */}
      <div className="flex shrink-0 items-center gap-2 md:gap-3">
        {/* 姓名與角色徽章手機上不顯示：430px 的頂欄放不下，而這個資訊
            在「今日總覽」上就有一份（您好，OOO／目前角色：OOO），
            在這裡重複一次的代價是把兩顆真的要按的按鈕擠壞。 */}
        {user && (
          <>
            <span className="hidden text-sm font-medium text-gray-700 md:inline">{user.name}</span>
            <span className="hidden md:inline">
              <StatusBadge tone={ROLE_TONE[user.role] || 'gray'}>
                {roleLabel(user.role)}
              </StatusBadge>
            </span>
          </>
        )}
        {user && (
          <button
            type="button"
            onClick={() => setOpenPwd(true)}
            className="min-h-[44px] whitespace-nowrap rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 md:min-h-0"
            title="修改自己的後台登入密碼"
          >
            個人設定
          </button>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="min-h-[44px] whitespace-nowrap rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 md:min-h-0"
        >
          登出
        </button>
      </div>
      <ChangePasswordModal
        open={openPwd}
        onClose={() => setOpenPwd(false)}
        initialUsername={user?.username || ''}
        requireCredentialChange={!!user?.must_change_credentials}
        onSaved={(result) => {
          if (!user) return;
          setUser({
            ...user,
            username: result.username || user.username,
            must_change_credentials: false,
          });
        }}
      />
    </header>
  );
}
