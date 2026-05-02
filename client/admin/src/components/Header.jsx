import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { roleLabel } from '../utils/format';
import StatusBadge from './StatusBadge';

const ROLE_TONE = { admin: 'primary', manager: 'teal', staff: 'gold' };

export default function Header() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const nav = useNavigate();

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
        <button
          type="button"
          onClick={onLogout}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
        >
          登出
        </button>
      </div>
    </header>
  );
}
