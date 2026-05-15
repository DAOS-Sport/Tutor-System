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
const ROLE_OPTIONS = [
  { value: 'admin',   label: '系統管理員' },
  { value: 'manager', label: '主管' },
  { value: 'staff',   label: '行政櫃檯' },
  { value: 'coach',   label: '教練' },
];
const MULTIPLIER_MIN = 1.00;
const MULTIPLIER_MAX = 1.50;

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
  const [togglingId, setTogglingId] = useState(null);

  if (!staff) return <LoadingSpinner fullPage />;

  async function toggleActive(row) {
    if (togglingId === row.id) return;
    const next = !row.active;
    // 樂觀更新：先翻轉 UI，失敗時還原
    setStaff((arr) => arr.map((x) => (x.id === row.id ? { ...x, active: next } : x)));
    setTogglingId(row.id);
    try {
      const res = await staffApi.update(row.id, { active: next });
      setStaff((arr) => arr.map((x) => (x.id === res.id ? res : x)));
      toast.success(`已${next ? '啟用' : '停用'} ${res.name}`);
    } catch {
      setStaff((arr) => arr.map((x) => (x.id === row.id ? { ...x, active: row.active } : x)));
      toast.error('狀態切換失敗');
    } finally {
      setTogglingId(null);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    // 教練修課係數依規格 100% – 150%（1.00–1.50）
    let mult = Number(editing.multiplier);
    if (editing.role === 'coach') {
      if (Number.isNaN(mult)) {
        toast.error('修課係數必須為數字');
        return;
      }
      if (mult < MULTIPLIER_MIN || mult > MULTIPLIER_MAX) {
        toast.error(`修課係數需介於 ${MULTIPLIER_MIN.toFixed(2)} – ${MULTIPLIER_MAX.toFixed(2)}（100% – 150%）`);
        return;
      }
    }
    setBusy(true);
    try {
      const patch = {
        role: editing.role,
        is_senior: editing.role === 'coach' ? !!editing.is_senior : false,
        multiplier: editing.role === 'coach' ? mult : 1,
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
      render: (r) => {
        const busy = togglingId === r.id;
        const on = !!r.active;
        return (
          <div className="inline-flex items-center gap-2">
            <button
              type="button"
              onClick={() => toggleActive(r)}
              disabled={busy}
              role="switch"
              aria-checked={on}
              aria-busy={busy}
              aria-label={`${on ? '停用' : '啟用'} ${r.name}`}
              title={on ? '點擊停用' : '點擊啟用'}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-wait ${
                on ? 'bg-brand-green' : 'bg-gray-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  on ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            {busy && (
              <span
                aria-hidden
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-brand-primary"
              />
            )}
          </div>
        );
      },
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
      <PageHeader title="員工帳號管理" subtitle="F-A02 · 指派角色 / 場館；教練可調整資深旗標與修課係數（1.00 – 1.50）" />
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
                <label className="mb-1 block text-sm font-medium text-gray-700">角色</label>
                <select
                  value={editing.role}
                  onChange={(e) => setEditing({ ...editing, role: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                >
                  {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <p className="mt-1 text-xs text-gray-500">變更角色會同步調整其登入後可見的選單與權限。</p>
              </div>
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
                    <label className="mb-1 block text-sm font-medium text-gray-700">
                      修課係數（100% – 150%）
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min={MULTIPLIER_MIN}
                      max={MULTIPLIER_MAX}
                      value={editing.multiplier}
                      onChange={(e) => setEditing({ ...editing, multiplier: e.target.value })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2"
                    />
                    <p className="mt-1 text-xs text-gray-500">資深教練 1.30 ~ 1.50；一般 1.00 ~ 1.20。</p>
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
