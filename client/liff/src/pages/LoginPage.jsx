import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parentsApi } from '../api/parents';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isValidTWPhone } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';

export default function LoginPage() {
  const navigate = useNavigate();
  const { setParent } = useAuth();
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
      const found = await parentsApi.findByPhone(phone.trim());
      if (found) {
        setParent(found);
        toast.success(`歡迎回來，${found.name}`);
        navigate('/', { replace: true });
      } else {
        toast.info('查無此手機，請完成註冊');
        navigate(`/register?phone=${encodeURIComponent(phone.trim())}`, { replace: true });
      }
    } catch (err) {
      toast.error('查詢失敗，請稍後再試');
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
            家長手機號碼
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
          <p className="mt-1 text-xs text-gray-500">系統會自動比對既有家長資料</p>
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:opacity-50"
        >
          {busy ? '查詢中…' : '登入 / 開始註冊'}
        </button>

        {busy && <LoadingSpinner label="比對 Ragic Z01 中…" />}

        <p className="pt-4 text-center text-xs text-gray-400">
          試用帳號（mock）：0912345678
        </p>
      </form>
    </div>
  );
}
