import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export default function ProfilePage() {
  const { parent, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  function handleLogout() {
    logout();
    toast.info('已登出');
    navigate('/login', { replace: true });
  }

  if (!parent) return null;

  return (
    <div className="px-4 py-4">
      <div className="mb-4 rounded-2xl bg-brand-primary p-4 text-white">
        <div className="text-xs opacity-80">家長帳號</div>
        <div className="mt-0.5 text-lg font-bold">{parent.name}</div>
        <div className="mt-1 text-xs opacity-90">{parent.phone}</div>
        {parent.email && <div className="text-xs opacity-90">{parent.email}</div>}
      </div>

      <Section title={`學員清單（${parent.students?.length || 0}）`}>
        {(parent.students || []).map((s) => (
          <div key={s.id} className="flex items-center justify-between border-b border-gray-100 py-2 last:border-0">
            <div>
              <div className="text-sm font-bold text-gray-900">{s.name}</div>
              <div className="text-xs text-gray-500">{s.id_number}</div>
            </div>
            <span className="text-xs text-gray-500">{s.gender}</span>
          </div>
        ))}
      </Section>

      <Section title="其他">
        <button
          type="button"
          onClick={handleLogout}
          className="w-full rounded-lg border border-brand-error/40 py-2.5 text-sm font-medium text-brand-error active:bg-brand-error-soft"
        >
          登出
        </button>
        <p className="mt-3 text-[11px] text-gray-400">
          本系統保留師生對話記錄供場館管理使用。
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
      <h3 className="mb-2 text-xs font-bold text-brand-primary">{title}</h3>
      {children}
    </div>
  );
}
