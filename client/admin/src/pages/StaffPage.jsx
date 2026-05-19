import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import FilterBar from '../components/FilterBar';
import StaffEditModal from './StaffEditModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { staffApi } from '../api/staff';
import { venuesApi } from '../api/venues';
import { roleLabel } from '../utils/format';

const EMPTY_FILTERS = { status: 'all', venueId: '', name: '', role: '', phone: '', senior: '' };
const ROLE_TONE = { admin: 'primary', manager: 'teal', staff: 'gold', coach: 'green' };
const MULTIPLIER_MIN = 1.00;
const MULTIPLIER_MAX = 1.50;

function roleBadges(row) {
  const badges = [{ role: row.role, active: true }];
  const knownRoles = Array.isArray(row.known_roles) ? row.known_roles : [];
  const coachActive = row.coach_profile_status === 'active' || row.coach_active;
  for (const role of knownRoles) {
    if (role && !badges.some((b) => b.role === role)) {
      badges.push({ role, active: role === 'coach' && row.has_coach_profile ? coachActive : false });
    }
  }
  if (row.has_coach_profile && row.role !== 'coach' && !badges.some((b) => b.role === 'coach')) {
    badges.push({ role: 'coach', active: coachActive });
  }
  return badges.map(({ role, active }) => (
    <StatusBadge
      key={role}
      tone={active ? (ROLE_TONE[role] || 'gray') : 'disabledRole'}
      title={active ? undefined : `${roleLabel(role)}身分暫停保留`}
    >
      {roleLabel(role)}
    </StatusBadge>
  ));
}

export default function StaffPage() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [staff, setStaff] = useState(null);
  const [venues, setVenues] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [syncing, setSyncing] = useState(false);
  const [createdHint, setCreatedHint] = useState(null);
  const [resetting, setResetting] = useState(null); // staff row pending reset confirm
  const [resetBusy, setResetBusy] = useState(false);

  async function confirmReset() {
    if (!resetting) return;
    setResetBusy(true);
    try {
      const r = await staffApi.resetPassword(resetting.id);
      if (r.notified) {
        toast.success(`已重設 ${r.staff_name || resetting.name} 的密碼，並已透過 LINE 通知`);
      } else {
        toast.success(`已重設 ${r.staff_name || resetting.name} 的密碼為員工編號（未發送 LINE 通知，請另行告知）`);
      }
      setResetting(null);
    } catch (err) {
      const msg = err?.response?.data?.error || '重設密碼失敗';
      toast.error(msg);
    } finally {
      setResetBusy(false);
    }
  }

  useEffect(() => { venuesApi.list().then(setVenues).catch(() => setVenues([])); }, []);

  function normalizeFilters(f) {
    const out = { ...f };
    if (out.venueId && venues.length) {
      const match = venues.find((v) => v.id === out.venueId || v.name === out.venueId);
      out.venueId = match ? match.id : out.venueId;
    }
    return out;
  }

  useEffect(() => {
    let cancel = false;
    staffApi.list(normalizeFilters(filters)).then((s) => { if (!cancel) setStaff(s); });
    return () => { cancel = true; };
  }, [filters, venues]);

  async function syncRagic() {
    setSyncing(true);
    try {
      const r = await staffApi.syncRagic();
      if (r.skipped) toast.info('未設定 Ragic credentials，略過');
      else toast.success(`已同步 ${r.synced || 0} 位員工`);
      const fresh = await staffApi.list(normalizeFilters(filters));
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
    if (editing.role === 'coach') {
      const mult = Number(editing.multiplier);
      if (Number.isNaN(mult) || mult < MULTIPLIER_MIN || mult > MULTIPLIER_MAX) {
        toast.error(`修課係數需介於 ${MULTIPLIER_MIN.toFixed(2)} – ${MULTIPLIER_MAX.toFixed(2)}（100% – 150%）`);
        return;
      }
    }
    setBusy(true);
    try {
      if (editing.isNew) {
        if (!/^[A-Z][0-9A-Z]{1,9}$/.test(String(editing.id || ''))) {
          toast.error('員工編號格式：英文字母開頭、2–10 碼英數');
          setBusy(false);
          return;
        }
        if (!editing.name?.trim()) { toast.error('姓名必填'); setBusy(false); return; }
        // 建立前確認 — 明示預設密碼規則
        const confirmMsg = `將建立員工 ${editing.name.trim()}（${editing.id}）：\n` +
          `• 角色：${roleLabel(editing.role)}\n` +
          `• 後台登入帳號：${editing.phone || editing.id}\n` +
          `• 預設登入密碼 = 員工編號（${editing.id}），請通知該員工首次登入後立即修改\n\n確認建立？`;
        if (!window.confirm(confirmMsg)) { setBusy(false); return; }
        const body = {
          id: editing.id, name: editing.name.trim(), role: editing.role,
          venue_id: editing.venue_id || null,
          phone: editing.phone || '',
          is_senior: editing.role === 'coach' ? !!editing.is_senior : false,
          multiplier: editing.role === 'coach' ? Number(editing.multiplier) : 1,
          active: editing.active !== false,
        };
        const res = await staffApi.create(body);
        toast.success(`已建立 ${res.name}（${res.id}）`);
        setCreatedHint({
          id: res.id, name: res.name,
          username: res.login_username || res.id,
          password: res.default_password_hint || res.id,
        });
        const fresh = await staffApi.list(normalizeFilters(filters));
        setStaff(fresh);
        setEditing(null);
      } else {
        const patch = {
          name: editing.name,
          phone: editing.phone,
          role: editing.role,
          is_senior: editing.role === 'coach' ? !!editing.is_senior : false,
          multiplier: editing.role === 'coach' ? Number(editing.multiplier) : 1,
          active: !!editing.active,
          venue_id: editing.venue_id || null,
        };
        if (editing.role !== 'coach') patch.coach_active = !!editing.coach_active;
        const res = await staffApi.update(editing.id, patch);
        setStaff((arr) => arr.map((x) => (x.id === res.id ? res : x)));
        toast.success(`已更新 ${res.name}`);
        setEditing(null);
      }
    } catch (err) {
      const msg = err?.response?.data?.error || (editing.isNew ? '建立失敗' : '更新失敗');
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  function startCreate() {
    setEditing({
      isNew: true, id: '', name: '', phone: '', role: 'staff', venue_id: '',
      is_senior: false, multiplier: 1, active: true,
    });
  }

  const columns = [
    { key: 'id', label: '編號', render: (r) => <span className="font-mono text-xs text-gray-500">{r.id}</span> },
    { key: 'name', label: '姓名', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'role', label: '角色',
      render: (r) => <div className="flex flex-wrap items-center gap-1.5">{roleBadges(r)}</div> },
    { key: 'venue_id', label: '場館', render: (r) => venueMap[r.venue_id] || '—' },
    { key: 'phone', label: '電話' },
    { key: 'is_senior', label: '資深', className: 'text-center',
      render: (r) => r.role === 'coach'
        ? (r.is_senior ? <StatusBadge tone="gold">資深</StatusBadge> : <span className="text-gray-400">—</span>)
        : <span className="text-gray-300">N/A</span> },
    { key: 'multiplier', label: '修課係數', className: 'text-right',
      render: (r) => r.role === 'coach' ? <span className="font-mono">{Number(r.multiplier).toFixed(2)}</span> : <span className="text-gray-300">—</span> },
    { key: 'has_login_account', label: '登入帳號', className: 'text-center',
      render: (r) => r.has_login_account
        ? <StatusBadge tone={r.login_active ? 'green' : 'gray'} title={r.login_username || ''}>
            {r.login_active ? '可登入' : '已停用'}
          </StatusBadge>
        : <span className="text-gray-300 text-xs">無</span> },
    { key: 'has_coach_profile', label: '教練資料', className: 'text-center',
      render: (r) => r.has_coach_profile
        ? (
            <Link to={`/coaches?name=${encodeURIComponent(r.name)}`}
              className="inline-block hover:opacity-80" title="到 F-C-Admin 編輯介紹/專長">
              <StatusBadge tone={r.coach_active ? 'green' : 'gray'}>
                {r.coach_active ? '上架中 →' : '已下架 →'}
              </StatusBadge>
            </Link>
          )
        : <span className="text-gray-300 text-xs">無</span> },
    { key: 'active', label: '狀態',
      render: (r) => {
        const busyRow = togglingId === r.id;
        const on = !!r.active;
        return (
          <div className="inline-flex items-center gap-2">
            <button type="button" onClick={() => toggleActive(r)} disabled={busyRow}
              role="switch" aria-checked={on} aria-busy={busyRow}
              aria-label={`${on ? '停用' : '啟用'} ${r.name}`}
              title={on ? '點擊停用' : '點擊啟用'}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-wait ${on ? 'bg-brand-green' : 'bg-gray-300'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            {busyRow && <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-brand-primary" />}
          </div>
        );
      },
    },
    { key: 'password', label: '密碼', className: 'text-center',
      render: (r) => (
        <div className="inline-flex items-center gap-2">
          <span className="font-mono text-gray-400 tracking-widest" title="密碼永不顯示明文">•••••••</span>
          {isAdmin && r.has_login_account && (
            <button type="button" onClick={() => setResetting(r)}
              className="text-xs font-medium text-brand-amber hover:underline"
              title={`重設 ${r.name} 的密碼為員工編號`}>
              重設
            </button>
          )}
        </div>
      ) },
    { key: 'actions', label: '操作', className: 'text-right',
      render: (r) => (
        <button className="text-xs font-medium text-brand-teal hover:underline" onClick={() => setEditing({ ...r })}>
          編輯
        </button>
      ) },
  ];

  const filterFields = [
    { key: 'status', label: '在職狀態', type: 'select', options: [
        { value: 'all', label: '全部' }, { value: 'active', label: '在職' }, { value: 'inactive', label: '離職' }] },
    { key: 'venueId', label: '所屬場館', type: 'combo',
      options: venues.map((v) => ({ value: v.id, label: `${v.id} ${v.name}` })), placeholder: '可輸入或選擇' },
    { key: 'name', label: '姓名', type: 'combo',
      options: (staff || []).map((s) => ({ value: s.name, label: s.name })), placeholder: '可輸入或選擇' },
    { key: 'role', label: '角色', type: 'select', options: [
        { value: '', label: '全部' }, { value: 'admin', label: '系統管理員' },
        { value: 'manager', label: '主管' }, { value: 'staff', label: '行政櫃檯' }, { value: 'coach', label: '教練' }] },
    { key: 'phone', label: '電話', type: 'input', placeholder: '末 4 碼或全號' },
    { key: 'senior', label: '資深', type: 'radio', options: [
        { value: '', label: '不限' }, { value: 'yes', label: '是' }, { value: 'no', label: '否' }] },
  ];

  return (
    <div>
      <PageHeader
        title="員工帳號管理"
        subtitle="F-A02 · 員工 / 登入帳號 / 教練資料三表單一事實來源；新建後自動建立登入帳號"
        actions={(
          <div className="flex gap-2">
            <button type="button" onClick={startCreate}
              className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white hover:bg-brand-teal">
              ＋ 新建員工
            </button>
            <button type="button" onClick={syncRagic} disabled={syncing}
              className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50">
              {syncing ? '同步中…' : '立即同步 Ragic'}
            </button>
          </div>
        )}
      />
      <FilterBar fields={filterFields} values={filters} onChange={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} />
      <DataTable columns={columns} rows={staff} rowKey={(r) => r.id} />

      <StaffEditModal
        editing={editing} setEditing={setEditing} venues={venues} busy={busy} onSave={saveEdit}
        multiplierMin={MULTIPLIER_MIN} multiplierMax={MULTIPLIER_MAX}
      />

      <ConfirmDialog
        open={!!resetting}
        title="重設員工密碼"
        confirmLabel="確認重設"
        tone="primary"
        busy={resetBusy}
        onCancel={() => !resetBusy && setResetting(null)}
        onConfirm={confirmReset}
      >
        {resetting && (
          <div className="space-y-2">
            <p>
              將把 <span className="font-bold">{resetting.name}</span>
              （編號 <span className="font-mono">{resetting.id}</span>）的後台登入密碼
              重設為員工編號 <span className="font-mono font-bold">{resetting.id}</span>。
            </p>
            <p className="text-xs text-gray-500">
              系統會嘗試以 LINE 通知該員工（若未綁定 LINE 則略過，請改用其他方式告知）。
              請提醒對方登入後立即修改密碼。
            </p>
          </div>
        )}
      </ConfirmDialog>

      {createdHint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => e.target === e.currentTarget && setCreatedHint(null)}
          role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-3 text-lg font-bold text-brand-green">✓ 員工已建立</h3>
            <p className="mb-2 text-sm text-gray-700">
              已為 <span className="font-bold">{createdHint.name}</span>（編號 <span className="font-mono">{createdHint.id}</span>）
              建立後台登入帳號與教練資料（若為教練）。
            </p>
            <div className="my-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm">
              <div className="font-medium text-amber-900">預設登入資訊</div>
              <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-amber-900">
                <span>帳號</span><span className="font-mono">{createdHint.username}</span>
                <span>密碼</span><span className="font-mono">{createdHint.password}</span>
              </div>
              <p className="mt-2 text-xs text-amber-800">請通知該員工首次登入後立即修改密碼。</p>
            </div>
            <div className="flex justify-end">
              <button onClick={() => setCreatedHint(null)}
                className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary">
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
