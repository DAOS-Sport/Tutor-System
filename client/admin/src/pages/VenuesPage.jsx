import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import VenueSyncDiffModal from '../components/VenueSyncDiffModal';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { venuesApi } from '../api/venues';

const FIELDS = [
  { key: 'name',     label: '場館名稱' },
  { key: 'address',  label: '地址' },
  { key: 'line_token', label: 'LINE Channel Token', type: 'password', hint: '對應該場館的 LINE Messaging API token' },
  { key: 'bank_institution_name', label: '收款銀行' },
  { key: 'bank_branch_name',      label: '銀行分行' },
  { key: 'account_holder',        label: '戶名' },
  { key: 'account_number',        label: '帳號' },
];

function ChevronIcon({ open }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"
      className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>
      <path d="M5 7l5 5 5-5" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Switch({ checked, disabled, onChange, ariaLabel }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(!checked); }}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition
        ${checked ? 'bg-brand-teal' : 'bg-gray-300'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform
        ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

function VenueCard({ venue, onSave, onToggleActive }) {
  const toast = useToast();
  const [draft, setDraft] = useState({ ...venue });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingActive, setPendingActive] = useState(null); // null | true | false
  const [toggling, setToggling] = useState(false);
  const dirty = FIELDS.some((f) => (draft[f.key] || '') !== (venue[f.key] || ''));
  const isActive = venue.is_active !== false;

  // venue prop 變動時同步 draft（toggle / 儲存後 parent 會傳新 venue）
  useEffect(() => { setDraft({ ...venue }); }, [venue]);

  async function save() {
    setBusy(true);
    try {
      const patch = Object.fromEntries(FIELDS.map((f) => [f.key, draft[f.key] || '']));
      await onSave(venue.id, patch);
      toast.success(`已儲存 ${venue.name}`);
    } catch {
      toast.error('儲存失敗');
    } finally {
      setBusy(false);
    }
  }

  async function confirmToggle() {
    setToggling(true);
    try {
      await onToggleActive(venue.id, pendingActive);
      toast.success(pendingActive ? `已啟用 ${venue.name}` : `已停用 ${venue.name}`);
      setPendingActive(null);
    } catch {
      toast.error('切換狀態失敗');
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className={`rounded-xl border bg-white shadow-sm transition
      ${isActive ? 'border-gray-200' : 'border-gray-300 bg-gray-50'}`}>
      {/* Header — 整列點擊可展開/折疊（Switch 自己 stopPropagation 不會觸發折疊）
          用 div + role=button 避免「button-in-button」非法巢狀互動標記 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); }
        }}
        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-5 py-4 text-left hover:bg-gray-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-base font-bold ${isActive ? 'text-brand-primary' : 'text-gray-500'}`}>
              {venue.name}
            </span>
            <span className="text-xs font-normal text-gray-400">({venue.code})</span>
            {isActive ? (
              <StatusBadge tone="green">啟用中</StatusBadge>
            ) : (
              <StatusBadge tone="gray" className="bg-gray-200 text-gray-600">停用中</StatusBadge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-gray-500">場館代碼 {venue.id}</div>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checked={isActive}
            disabled={toggling}
            onChange={(next) => setPendingActive(next)}
            ariaLabel={`切換 ${venue.name} 啟用狀態`}
          />
          <ChevronIcon open={open} />
        </div>
      </div>

      {/* Body — 折疊內容 */}
      {open && (
        <div className="border-t border-gray-100 px-5 pb-5 pt-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="mb-1 block text-sm font-medium text-gray-700">{f.label}</label>
                <input
                  type={f.type || 'text'}
                  value={draft[f.key] || ''}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-brand-teal"
                />
                {f.hint && <p className="mt-1 text-xs text-gray-500">{f.hint}</p>}
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={save}
              disabled={!dirty || busy}
              className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
            >
              {busy ? '儲存中…' : '儲存此館'}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingActive !== null}
        title={pendingActive ? `啟用 ${venue.name}？` : `停用 ${venue.name}？`}
        confirmLabel={pendingActive ? '確認啟用' : '確認停用'}
        tone={pendingActive ? 'primary' : 'danger'}
        busy={toggling}
        onCancel={() => !toggling && setPendingActive(null)}
        onConfirm={confirmToggle}
      >
        {pendingActive ? (
          <p>啟用後家長端 LIFF 將可選擇此場館報名新課程，員工 / 教練編輯下拉也會再次顯示此場館。</p>
        ) : (
          <div className="space-y-2">
            <p>停用後：</p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>家長端 LIFF 將無法看到此場館，提交新報名會被後端拒絕。</li>
              <li>後台員工 / 教練編輯下拉會自動隱藏此場館（但已綁定者仍會保留顯示）。</li>
              <li className="font-medium text-brand-error">
                已售出的課程（admin_enrollments）不會被取消，仍可正常上課 / 對帳 / 退款。
              </li>
            </ul>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

export default function VenuesPage() {
  const toast = useToast();
  const [venues, setVenues] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [diff, setDiff] = useState(null);

  useEffect(() => { venuesApi.list().then(setVenues); }, []);

  async function onSave(id, patch) {
    const res = await venuesApi.update(id, patch);
    setVenues((arr) => arr.map((v) => (v.id === res.id ? { ...v, ...res } : v)));
  }

  async function onToggleActive(id, isActive) {
    const res = await venuesApi.toggleActive(id, isActive);
    setVenues((arr) => arr.map((v) => (v.id === id ? { ...v, ...res, is_active: isActive } : v)));
  }

  async function onSyncClick() {
    setSyncing(true);
    try {
      const result = await venuesApi.syncDryRun();
      if (result?.skipped) {
        toast.warning(result.reason || 'Ragic 未設定，無法同步');
        return;
      }
      setDiff(result);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Ragic 同步失敗，請稍後再試');
    } finally {
      setSyncing(false);
    }
  }

  async function onConfirmSync(selections) {
    try {
      const r = await venuesApi.syncConfirm(selections);
      toast.success(`已新增 ${r.added} / 更動 ${r.updated} / 移除 ${r.removed} 筆`);
      setDiff(null);
      const fresh = await venuesApi.list();
      setVenues(fresh);
    } catch (err) {
      toast.error(err?.response?.data?.error || '套用失敗');
    }
  }

  if (!venues) return <LoadingSpinner fullPage />;

  return (
    <div>
      <PageHeader
        title="場館設定"
        subtitle="F-A03 · 每館自帶 LINE Token、收款銀行帳戶與基本資料；可隨時停用某館停止新報名"
        actions={
          <button
            onClick={onSyncClick}
            disabled={syncing}
            className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
          >
            {syncing ? '檢查中…' : '立即同步 Ragic'}
          </button>
        }
      />
      <div className="space-y-3">
        {venues.map((v) => (
          <VenueCard key={v.id} venue={v} onSave={onSave} onToggleActive={onToggleActive} />
        ))}
      </div>
      {diff && (
        <VenueSyncDiffModal
          diff={diff}
          onCancel={() => setDiff(null)}
          onConfirm={onConfirmSync}
        />
      )}
    </div>
  );
}
