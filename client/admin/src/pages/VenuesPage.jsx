import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
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

function VenueCard({ venue, onSave }) {
  const toast = useToast();
  const [draft, setDraft] = useState({ ...venue });
  const [busy, setBusy] = useState(false);
  const dirty = FIELDS.some((f) => (draft[f.key] || '') !== (venue[f.key] || ''));

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

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-base font-bold text-brand-primary">
            {venue.name} <span className="text-xs font-normal text-gray-400">({venue.code})</span>
          </div>
          <div className="text-xs text-gray-500">場館代碼 {venue.id}</div>
        </div>
        <button
          onClick={save}
          disabled={!dirty || busy}
          className="rounded-lg bg-brand-teal px-3 py-1.5 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
        >
          {busy ? '儲存中…' : '儲存此館'}
        </button>
      </div>
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
    </div>
  );
}

export default function VenuesPage() {
  const [venues, setVenues] = useState(null);

  useEffect(() => { venuesApi.list().then(setVenues); }, []);

  async function onSave(id, patch) {
    const res = await venuesApi.update(id, patch);
    setVenues((arr) => arr.map((v) => (v.id === res.id ? res : v)));
  }

  if (!venues) return <LoadingSpinner fullPage />;

  return (
    <div>
      <PageHeader title="場館設定" subtitle="F-A03 · 每館自帶 LINE Token、收款銀行帳戶與基本資料" />
      <div className="space-y-5">
        {venues.map((v) => <VenueCard key={v.id} venue={v} onSave={onSave} />)}
      </div>
    </div>
  );
}
