import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { settingsApi } from '../api/settings';

const FIELDS = [
  { key: 'sessions_per_period',     label: '每期堂數',          type: 'number', min: 1,  max: 24,  hint: '一期課程包含幾堂' },
  { key: 'validity_days',           label: '課程有效天數',      type: 'number', min: 30, max: 730, hint: '購課後到期天數' },
  { key: 'expiry_notice_days',      label: '到期提醒天數',      type: 'number', min: 7,  max: 180, hint: '到期前幾天發送提醒' },
  { key: 'refund_fee_rate',         label: '退費手續費率',      type: 'number', step: 0.01, min: 0, max: 1, hint: '0~1，例如 0.10 = 10%' },
  { key: 'transfer_fee',            label: '轉讓手續費 (NTD)',  type: 'number', min: 0, max: 5000, hint: '老師更換時收取' },
  { key: 'default_session_minutes', label: '單堂預設長度 (分鐘)', type: 'number', min: 30, max: 180 },
  { key: 'multi_confirm_minutes',   label: '1對多確認時限 (分鐘)', type: 'number', min: 10, max: 720, hint: '同組家長未確認則回退' },
];

export default function SettingsPage() {
  const toast = useToast();
  // draft 一律存「字串」讓使用者能正常輸入小數（例 0.10 / 0.1）
  // 進入畫面時把 server 回來的 number 轉字串顯示，存檔時再 parse
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    settingsApi.get().then((d) => {
      const obj = {};
      for (const f of FIELDS) obj[f.key] = String(d[f.key] ?? '');
      setDraft(obj);
    }).catch((e) => {
      // 不能用空白預設值頂替（誤存會洗掉真實參數）→ 顯示錯誤頁 + 重新載入按鈕
      toast.error(e?.response?.data?.error || '載入系統參數失敗');
      setLoadError(true);
    });
  }, []);

  if (loadError) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3">
        <p className="text-sm text-gray-600">系統參數載入失敗，請檢查網路或稍後再試。</p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary"
        >
          重新載入
        </button>
      </div>
    );
  }
  if (!draft) return <LoadingSpinner fullPage />;

  function setField(k, v) {
    setDraft({ ...draft, [k]: v });
  }

  async function onSave() {
    const parsed = {};
    for (const f of FIELDS) {
      const raw = String(draft[f.key] ?? '').trim();
      const n = Number(raw);
      if (raw === '' || Number.isNaN(n)) {
        toast.error(`「${f.label}」必須為數字`);
        return;
      }
      parsed[f.key] = n;
    }
    setBusy(true);
    try {
      const res = await settingsApi.update(parsed);
      const obj = {};
      for (const f of FIELDS) obj[f.key] = String(res[f.key] ?? '');
      setDraft(obj);
      toast.success('系統設定已儲存');
    } catch {
      toast.error('儲存失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="全域系統設定"
        subtitle="F-A01 · 影響所有場館的計算規則"
        actions={
          <button
            onClick={onSave}
            disabled={busy}
            className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
          >
            {busy ? '儲存中…' : '儲存設定'}
          </button>
        }
      />
      <div className="grid grid-cols-1 gap-5 rounded-xl border border-gray-200 bg-white p-6 shadow-sm md:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className="mb-1 block text-sm font-medium text-gray-700">{f.label}</label>
            <input
              type={f.type}
              step={f.step || 1}
              min={f.min}
              max={f.max}
              value={draft[f.key]}
              onChange={(e) => setField(f.key, e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-brand-teal"
            />
            {f.hint && <p className="mt-1 text-xs text-gray-500">{f.hint}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
