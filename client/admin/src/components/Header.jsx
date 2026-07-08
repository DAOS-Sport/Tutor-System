import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { roleLabel } from '../utils/format';
import StatusBadge from './StatusBadge';
import ChangePasswordModal from './ChangePasswordModal';

const ROLE_TONE = { admin: 'primary', manager: 'teal', staff: 'gold' };

export default function Header() {
  const { user, logout, setUser } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [openPwd, setOpenPwd] = useState(false);
  const promptedDefaultCredentials = useRef(false);

  useEffect(() => {
    if (user?.must_change_credentials && !promptedDefaultCredentials.current) {
      promptedDefaultCredentials.current = true;
      setOpenPwd(true);
      toast.warning('目前仍使用預設帳密，建議至個人設定更新帳號或密碼', 5000);
    }
  }, [toast, user?.must_change_credentials]);

  const onLogout = () => {
    logout();
    toast.info('已登出');
    nav('/login', { replace: true });
  };

  return (
    <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div className="text-sm text-gray-500">夢想體育學院 · 管理後台</div>
      <div className="flex items-center gap-3">
        {user && (
          <>
            <span className="text-sm font-medium text-gray-700">{user.name}</span>
            <StatusBadge tone={ROLE_TONE[user.role] || 'gray'}>
              {roleLabel(user.role)}
            </StatusBadge>
          </>
        )}
        {user && (
          <button
            type="button"
            onClick={() => setOpenPwd(true)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            title="修改自己的後台登入密碼"
          >
            個人設定
          </button>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
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
