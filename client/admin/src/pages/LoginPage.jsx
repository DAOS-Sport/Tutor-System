import React, { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth';
import { USE_MOCK } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export default function LoginPage() {
  const { setUser, isAuthed } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const loc = useLocation();
  const [form, setForm] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(false);

  // Task #68：interceptor 因 401 把使用者踢回登入時會 set 此 flag → 顯示一次明確提示
  // useRef sentinel 防 React.StrictMode dev 環境 effect 重複執行造成 toast 顯兩次
  const flashShown = useRef(false);
  useEffect(() => {
    if (flashShown.current) return;
    flashShown.current = true;
    try {
      if (sessionStorage.getItem('daos.admin.flashLogout') === '1') {
        sessionStorage.removeItem('daos.admin.flashLogout');
        toast.warning('登入逾期或權限變更，請重新登入');
      }
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isAuthed) {
    return <Navigate to={loc.state?.from || '/dashboard'} replace />;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!form.username || !form.password) {
      toast.warning('請輸入帳號與密碼');
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.login(form);
      if (!res) {
        // Task #68：production 下若使用者仍嘗試 admin/admin，提示初始密碼來源
        if (!USE_MOCK) {
          toast.error('帳號或密碼錯誤（初始密碼由部署時的 ADMIN_BOOTSTRAP_PASSWORD 決定，非 admin）');
        } else {
          toast.error('帳號或密碼錯誤');
        }
        return;
      }
      setUser(res);
      toast.success(`歡迎回來，${res.name}`);
      const from = loc.state?.from || '/dashboard';
      nav(from, { replace: true });
    } catch (err) {
      console.error(err);
      toast.error('登入失敗，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-primary via-brand-primary to-brand-teal px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold text-brand-primary">DAOS 管理後台</div>
          <div className="mt-1 text-sm text-gray-500">夢想體育學院 · 家教課程系統</div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">帳號</label>
            <input
              type="text"
              autoComplete="username"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-brand-teal"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.trim() })}
              placeholder={USE_MOCK ? 'admin / staff' : '請輸入員工編號'}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">密碼</label>
            <input
              type="password"
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-brand-teal"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder={USE_MOCK ? '與帳號相同' : '請輸入電話號碼'}
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-primary py-2.5 font-bold text-white hover:bg-brand-teal disabled:opacity-50"
          >
            {busy ? '登入中…' : '登入'}
          </button>
        </form>

        {USE_MOCK ? (
          <div className="mt-6 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            <div className="mb-1 font-bold text-gray-700">Mock 測試帳號（密碼=帳號）</div>
            <ul className="list-disc pl-5">
              <li><b>admin</b> — 系統管理員（看得到全部功能）</li>
              <li><b>staff</b> — 行政櫃檯（板橋館，無退課/系統設定）</li>
            </ul>
          </div>
        ) : (
          <div className="mt-6 rounded-lg bg-gray-50 p-3 text-xs text-gray-500">
            <div>後台登入限系統管理員、主管與行政櫃檯；預設帳號為員工編號，預設密碼為電話號碼。</div>
            <div className="mt-1 text-[11px] text-gray-400">
              首次部署的初始密碼由 <code>ADMIN_BOOTSTRAP_PASSWORD</code> 決定（非 <code>admin</code>）。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
