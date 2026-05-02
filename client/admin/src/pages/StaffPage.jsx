import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { staffApi } from '../api/staff';
import { venuesApi } from '../api/venues';
import { roleLabel } from '../utils/format';

const ROLE_TONE = { admin: 'primary', manager: 'teal', staff: 'gold', coach: 'green' };

export default function StaffPage() {
  const toast = useToast();
  const [staff, setStaff] = useState(null);
  const [venues, setVenues] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([staffApi.list(), venuesApi.list()]).then(([s, v]) => {
      setStaff(s); setVenues(v);
    });
  }, []);

  const venueMap = useMemo(() => Object.fromEntries(venues.map((v) => [v.id, v.name])), [venues]);

  if (!staff) return <LoadingSpinner fullPage />;

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    try {
      const patch = {
        is_senior: !!editing.is_senior,
        multiplier: Number(editing.multiplier) || 1,
        active: !!editing.active,
        venue_id: editing.venue_id || null,
      };
      const res = await staffApi.update(editing.id, patch);
      setStaff((arr) => arr.map((x) => (x.id === res.id ? res : x)));
      toast.success(`已更新 ${res.name}`);
      setEditing(null);
    } catch {
      toast.error('更新失敗');
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: 'name', label: '姓名', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'role', label: '角色', render: (r) => <StatusBadge tone={ROLE_TONE[r.role] || 'gray'}>{roleLabel(r.role)}</StatusBadge> },
    { key: 'venue_id', label: '場館', render: (r) => venueMap[r.venue_id] || '—' },
    { key: 'phone', label: '聯絡電話' },
    {
      key: 'is_senior', label: '資深', className: 'text-center',
      render: (r) => r.role === 'coach'
        ? (r.is_senior ? <StatusBadge tone="gold">資深</StatusBadge> : <span className="text-gray-400">—</span>)
        : <span className="text-gray-300">N/A</span>,
    },
    {
      key: 'multiplier', label: '修課係數', className: 'text-right',
      render: (r) => r.role === 'coach' ? <span className="font-mono">{Number(r.multiplier).toFixed(2)}</span> : <span className="text-gray-300">—</span>,
    },
    {
      key: 'active', label: '狀態',
      render: (r) => r.active
        ? <StatusBadge tone="green">啟用</StatusBadge>
        : <StatusBadge tone="gray">停用</StatusBadge>,
    },
    {
      key: 'actions', label: '操作', className: 'text-right',
      render: (r) => (
        <button
          className="text-xs font-medium text-brand-teal hover:underline"
          onClick={() => setEditing({ ...r })}
        >
          編輯
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="員工帳號管理" subtitle="F-A02 · 教練可調整資深旗標與修課係數" />
      <DataTable columns={columns} rows={staff} rowKey={(r) => r.id} />

      {editing && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => e.target === e.currentTarget && setEditing(null)}
          role="dialog"
          aria-modal="true"
          aria-label="編輯員工"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-bold text-brand-primary">編輯員工 — {editing.name}</h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">所屬場館</label>
                <select
                  value={editing.venue_id || ''}
                  onChange={(e) => setEditing({ ...editing, venue_id: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                >
                  <option value="">— 不指定 —</option>
                  {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
              {editing.role === 'coach' && (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!editing.is_senior}
                      onChange={(e) => setEditing({ ...editing, is_senior: e.target.checked })}
                    />
                    <span>資深教練（可建立學習歷程、會顯示金色徽章）</span>
                  </label>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">修課係數</label>
                    <input
                      type="number" step="0.01" min="0.5" max="2"
                      value={editing.multiplier}
                      onChange={(e) => setEditing({ ...editing, multiplier: e.target.value })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2"
                    />
                  </div>
                </>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                <span>啟用此帳號</span>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                disabled={busy}
              >
                取消
              </button>
              <button
                onClick={saveEdit}
                disabled={busy}
                className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
              >
                {busy ? '儲存中…' : '儲存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
