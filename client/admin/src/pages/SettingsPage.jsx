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

/**
 * 推播安全閥（server/services/pushGate.js）。
 *
 * 預設值必須與 pushGate.DEFAULTS 一致 —— 正式庫可能一筆設定都沒有，
 * 這時畫面顯示的必須是「實際生效的值」而不是空白，否則按下儲存就會把
 * 想像中的預設寫進資料庫。
 */
const PUSH_DEFAULTS = {
  push_enabled: '0',
  push_dry_run: '1',
  push_max_per_hour: '50',
  push_event_checkin_confirmed_coach: '0',
};

const PUSH_TOGGLES = [
  { key: 'push_enabled', label: '推播總開關',
    hint: '關閉時所有 LINE 推播一律不送，個別事件開了也沒用' },
  { key: 'push_dry_run', label: '演練模式（只記錄、不送出）',
    hint: '⚠️ 預設是「開」。總開關打開但這個沒關掉的話，line_push_log 會照常寫紀錄，看起來一切正常，但一則都不會送出' },
  { key: 'push_event_checkin_confirmed_coach', label: '家長簽到 → 通知教練',
    hint: '教練端目前唯一的推播事件（走 dreams400）' },
];
const PUSH_NUMBERS = [
  { key: 'push_max_per_hour', label: '每小時送出上限', type: 'number', min: 0, max: 1000,
    hint: 'dreams400 全場館共用，每月 3,000 則額度' },
];
const PUSH_KEYS = [...PUSH_TOGGLES, ...PUSH_NUMBERS].map((f) => f.key);
const PUSH_EVENT_KEYS = PUSH_TOGGLES.filter((f) => f.key.startsWith('push_event_')).map((f) => f.key);

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
      // 沒有設定列時要顯示 pushGate 實際生效的預設，不能留空白 ——
      // 空白會讓人以為「還沒設定」，一按儲存就把想像中的值寫進去。
      for (const k of PUSH_KEYS) obj[k] = String(d[k] ?? PUSH_DEFAULTS[k]);
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

  // 三個開關的組合判讀。最容易踩的是「總開關開、事件開，但演練模式沒關」——
  // 閘門會放行、紀錄照寫，看起來一切正常，實際上一則都沒送出。
  const pushState = (() => {
    const on = draft.push_enabled === '1';
    const dry = draft.push_dry_run === '1';
    const anyEvent = PUSH_EVENT_KEYS.some((k) => draft[k] === '1');
    if (!on) return { cls: 'bg-gray-100 text-gray-600', text: '全部關閉 —— 任何 LINE 推播都不會送出' };
    if (!anyEvent) return { cls: 'bg-gray-100 text-gray-600', text: '總開關已開，但沒有啟用任何事件 —— 仍然不會送出' };
    if (dry) return { cls: 'bg-amber-100 text-amber-800', text: '演練模式 —— 會寫入紀錄，但「不會」真的送出。要實際發送請取消勾選演練模式。' };
    return { cls: 'bg-emerald-100 text-emerald-800', text: '實際發送中 —— 符合條件的通知會真的送到收訊者的 LINE' };
  })();

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
    for (const k of PUSH_KEYS) parsed[k] = Number(draft[k] ?? PUSH_DEFAULTS[k]);
    setBusy(true);
    try {
      const res = await settingsApi.update(parsed);
      const obj = {};
      for (const f of FIELDS) obj[f.key] = String(res[f.key] ?? '');
      for (const k of PUSH_KEYS) obj[k] = String(res[k] ?? PUSH_DEFAULTS[k]);
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

      {/* 推播安全閥。獨立成一張卡是刻意的：它跟上面那些「計算規則」性質完全不同，
          改錯的後果是「發了不該發的訊息給客戶」，不是算錯一個數字。 */}
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-bold text-gray-800">LINE 推播安全閥</h3>
        <p className="mt-1 text-xs text-gray-500">
          三道閘門必須同時通過才會真的送出：總開關 → 個別事件 → 非演練模式。
        </p>

        {/* 即時判讀。三個開關的組合有一種「看起來開了其實不會送」的狀態
            （總開關開、事件開、但演練模式沒關），光看勾選框分辨不出來。 */}
        <div className={`mt-3 rounded-lg px-3 py-2 text-sm font-medium ${pushState.cls}`}>
          目前狀態：{pushState.text}
        </div>

        <div className="mt-4 space-y-3">
          {PUSH_TOGGLES.map((f) => (
            <label key={f.key} className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={draft[f.key] === '1'}
                onChange={(e) => setField(f.key, e.target.checked ? '1' : '0')}
                className="mt-0.5 h-4 w-4 shrink-0 accent-brand-teal"
              />
              <span>
                <span className="block text-sm font-medium text-gray-700">{f.label}</span>
                <span className="mt-0.5 block text-xs text-gray-500">{f.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
          {PUSH_NUMBERS.map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-sm font-medium text-gray-700">{f.label}</label>
              <input
                type="number"
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
    </div>
  );
}
