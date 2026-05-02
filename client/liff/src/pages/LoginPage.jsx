import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parentsApi } from '../api/parents';
import { coachesApi } from '../api/coaches';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isValidTWPhone } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';

/**
 * LIFF 登入：以手機作為通用識別。
 *  1. 先試家長 (Z01) — 找到 → 走家長分頁
 *  2. 找不到再試教練 (H01) — 找到 → 走教練分頁
 *  3. 都找不到 → 引導家長註冊
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const { setParent, setCoach } = useAuth();
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!isValidTWPhone(phone)) {
      toast.error('請輸入正確的台灣手機號碼（09xxxxxxxx）');
      return;
    }
    setBusy(true);
    try {
      const trimmed = phone.trim();
      const parent = await parentsApi.findByPhone(trimmed);
      if (parent) {
        setParent(parent);
        toast.success(`歡迎回來，${parent.name}`);
        navigate('/', { replace: true });
        return;
      }
      // 嘗試教練端登入：明確區分「真的查無此手機(404)」vs「速率限制(429)」vs「其他錯誤(5xx/network)」
      let coach = null;
      try {
        coach = await coachesApi.byPhone(trimmed);
      } catch (err) {
        const status = err?.response?.status;
        if (status === 429) {
          toast.error('登入嘗試過於頻繁，請 5 分鐘後再試');
          return;
        }
        if (status && status >= 500) {
          toast.error('伺服器忙線中，請稍後再試');
          return;
        }
        if (status && status !== 404) {
          toast.error(`查詢失敗（${status}）`);
          return;
        }
        coach = null; // 404 → 真的查無
      }
      if (coach) {
        setCoach(coach);
        toast.success(`歡迎，${coach.name} 教練`);
        navigate('/coach', { replace: true });
        return;
      }
      toast.info('查無此手機，請完成家長註冊');
      navigate(`/register?phone=${encodeURIComponent(trimmed)}`, { replace: true });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) toast.error('登入嘗試過於頻繁，請 5 分鐘後再試');
      else if (status && status >= 500) toast.error('伺服器忙線中，請稍後再試');
      else toast.error('查詢失敗，請稍後再試');
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
        <p className="mt-1 text-sm text-gray-500">家教課程系統</p>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-[320px] space-y-4">
        <div>
          <label htmlFor="phone" className="mb-1 block text-sm font-medium text-gray-700">
            手機號碼
          </label>
          <input
            id="phone"
            type="tel"
            inputMode="numeric"
            placeholder="09xxxxxxxx"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
            disabled={busy}
          />
          <p className="mt-1 text-xs text-gray-500">系統會自動判斷家長 / 教練身分</p>
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:opacity-50"
        >
          {busy ? '查詢中…' : '登入 / 開始註冊'}
        </button>

        {busy && <LoadingSpinner label="比對 Z01 / H01 中…" />}

        <div className="pt-4 text-center text-xs leading-5 text-gray-400">
          試用帳號（mock）
          <br />家長：0912345678　教練：0911000001
        </div>
      </form>
    </div>
  );
}
