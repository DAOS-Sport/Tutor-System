import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';

/**
 * Demo 登入頁（/demo）— 手機功能測試用，繞過 LINE。
 * 後端 ALLOW_DEMO_LOGIN=1 時才會成功；否則回 404。
 * 預設帳號：教練 coach/coach、家長 custom/custom。
 */
export default function DemoLoginPage() {
  const navigate = useNavigate();
  const { setParent, setCoach } = useAuth();
  const toast = useToast();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  function fill(u, p) {
    setUsername(u);
    setPassword(p);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password) {
      toast.error('請輸入帳號與密碼');
      return;
    }
    setBusy(true);
    try {
      const r = await authApi.demoLogin({ username: username.trim(), password });
      if (r?.role === 'coach') {
        setCoach({ ...r, token: r.token || null });
        toast.success(`歡迎，${r.name} 教練（Demo）`);
        navigate('/coach', { replace: true });
        return;
      }
      if (r?.role === 'parent') {
        setParent({ ...r, token: r.token || null });
        toast.success(`歡迎，${r.name || ''}（Demo）`);
        navigate('/', { replace: true });
        return;
      }
      toast.error('登入失敗，請稍後再試。');
    } catch (err) {
      const code = err?.response?.status;
      if (code === 404) toast.error('Demo 登入未開啟（請設定 ALLOW_DEMO_LOGIN=1）。');
      else if (code === 401) toast.error('帳號或密碼錯誤。');
      else toast.error('登入失敗，請稍後再試。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-primary text-2xl font-bold text-white">
          DAOS
        </div>
        <h1 className="text-xl font-bold text-brand-primary">夢想體育學院</h1>
        <p className="mt-1 text-sm text-gray-500">功能測試登入（Demo）</p>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-[320px] space-y-4">
        <div>
          <label htmlFor="demo-username" className="mb-1 block text-sm font-medium text-gray-700">帳號</label>
          <input
            id="demo-username"
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="coach 或 custom"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
            disabled={busy}
          />
        </div>
        <div>
          <label htmlFor="demo-password" className="mb-1 block text-sm font-medium text-gray-700">密碼</label>
          <input
            id="demo-password"
            type="password"
            placeholder="密碼"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
            disabled={busy}
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:opacity-50"
        >
          {busy ? '登入中…' : '登入'}
        </button>

        {busy && <LoadingSpinner label="登入中…" />}

        <div className="space-y-2 pt-2">
          <button type="button" onClick={() => fill('coach', 'coach')} disabled={busy}
            className="w-full rounded-lg border border-brand-teal/40 bg-brand-teal/5 py-2 text-sm font-medium text-brand-primary active:bg-brand-teal/10">
            帶入教練 Demo 帳號（coach / coach）
          </button>
          <button type="button" onClick={() => fill('coach2', 'coach2')} disabled={busy}
            className="w-full rounded-lg border border-brand-teal/40 bg-brand-teal/5 py-2 text-sm font-medium text-brand-primary active:bg-brand-teal/10">
            帶入教練2 Demo 帳號（coach2 / coach2）— 測轉換教練
          </button>
          <button type="button" onClick={() => fill('custom', 'custom')} disabled={busy}
            className="w-full rounded-lg border border-brand-teal/40 bg-brand-teal/5 py-2 text-sm font-medium text-brand-primary active:bg-brand-teal/10">
            帶入家長 Demo 帳號（custom / custom）
          </button>
          <button type="button" onClick={() => navigate('/register?demo=1')} disabled={busy}
            className="w-full rounded-lg border border-amber-400/60 bg-amber-50 py-2 text-sm font-medium text-amber-800 active:bg-amber-100">
            Demo 新用戶：測試「引導註冊」流程（會建立測試資料）
          </button>
        </div>

        <p className="pt-2 text-center text-xs leading-5 text-gray-400">
          此頁僅供功能測試，繞過 LINE 登入。
        </p>
      </form>
    </div>
  );
}
