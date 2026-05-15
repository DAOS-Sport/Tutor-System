import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import FilterBar from '../components/FilterBar';
import StaffEditModal from './StaffEditModal';
import { useToast } from '../context/ToastContext';
import { staffApi } from '../api/staff';
import { venuesApi } from '../api/venues';
import { roleLabel } from '../utils/format';

const EMPTY_FILTERS = { status: 'all', venueId: '', name: '', role: '', phone: '', senior: '' };
const ROLE_TONE = { admin: 'primary', manager: 'teal', staff: 'gold', coach: 'green' };
const MULTIPLIER_MIN = 1.00;
const MULTIPLIER_MAX = 1.50;

export default function StaffPage() {
  const toast = useToast();
  const [staff, setStaff] = useState(null);
  const [venues, setVenues] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [syncing, setSyncing] = useState(false);

  // 場館載入一次（用作 combo 選項 + 顯示對照）
  useEffect(() => { venuesApi.list().then(setVenues).catch(() => setVenues([])); }, []);

  // 過濾條件變動時重打 API（伺服器端過濾，避免 client 端二次處理）
  useEffect(() => {
    let cancel = false;
    // 把 venueId 從 combo 名稱反查回 id（允許使用者直接輸入名稱）
    const apiFilters = { ...filters };
    if (apiFilters.venueId && venues.length) {
      const match = venues.find((v) => v.id === apiFilters.venueId || v.name === apiFilters.venueId);
      apiFilters.venueId = match ? match.id : apiFilters.venueId;
    }
    staffApi.list(apiFilters).then((s) => { if (!cancel) setStaff(s); });
    return () => { cancel = true; };
  }, [filters, venues]);

  async function syncRagic() {
    setSyncing(true);
    try {
      const r = await staffApi.syncRagic();
      if (r.skipped) toast.info('未設定 Ragic credentials，略過');
      else toast.success(`已同步 ${r.synced || 0} 位員工`);
      const fresh = await staffApi.list(filters);
      setStaff(fresh);
    } catch {
      toast.error('Ragic 同步失敗');
    } finally {
      setSyncing(false);
    }
  }

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

  const filterFields = [
    { key: 'status', label: '在職狀態', type: 'select', options: [
        { value: 'all',      label: '全部' },
        { value: 'active',   label: '在職' },
        { value: 'inactive', label: '離職' },
      ] },
    { key: 'venueId', label: '所屬場館', type: 'combo',
      options: venues.map((v) => ({ value: v.id, label: `${v.id} ${v.name}` })),
      placeholder: '可輸入或選擇' },
    { key: 'name',  label: '姓名', type: 'combo',
      options: (staff || []).map((s) => ({ value: s.name, label: s.name })),
      placeholder: '可輸入或選擇' },
    { key: 'role',  label: '角色', type: 'select', options: [
        { value: '',        label: '全部' },
        { value: 'admin',   label: '系統管理員' },
        { value: 'manager', label: '主管' },
        { value: 'staff',   label: '行政櫃檯' },
        { value: 'coach',   label: '教練' },
      ] },
    { key: 'phone', label: '電話', type: 'input', placeholder: '末 4 碼或全號' },
    { key: 'senior', label: '資深', type: 'radio', options: [
        { value: '',    label: '不限' },
        { value: 'yes', label: '是' },
        { value: 'no',  label: '否' },
      ] },
  ];

  return (
    <div>
      <PageHeader
        title="員工帳號管理"
        subtitle="F-A02 · 指派角色 / 場館；教練可調整資深旗標與修課係數（1.00 – 1.50）"
        actions={(
          <button
            type="button"
            onClick={syncRagic}
            disabled={syncing}
            className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
          >
            {syncing ? '同步中…' : '立即同步 Ragic'}
          </button>
        )}
      />
      <FilterBar
        fields={filterFields}
        values={filters}
        onChange={setFilters}
        onReset={() => setFilters(EMPTY_FILTERS)}
      />
      <DataTable columns={columns} rows={staff} rowKey={(r) => r.id} />

      <StaffEditModal
        editing={editing}
        setEditing={setEditing}
        venues={venues}
        busy={busy}
        onSave={saveEdit}
        multiplierMin={MULTIPLIER_MIN}
        multiplierMax={MULTIPLIER_MAX}
      />
    </div>
  );
}

