import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import FilterBar from '../components/FilterBar';
import ConfirmDialog from '../components/ConfirmDialog';
import RagicZ01Modal from './RagicZ01Modal';
import { useToast } from '../context/ToastContext';
import { customerParentsApi } from '../api/customers';
import { venuesApi } from '../api/venues';

// 預設只看啟用中：active 鏡像政策上只收「已綁 LINE UID」的登入會員，
// 歷史未綁殘留列都已停用，預設不再攤在清單裡（要查可切「全部／已停用」）。
const EMPTY_FILTERS = { status: 'active', venueId: '', name: '', identity: '', phone: '' };
const IDENTITY_TONE = { '教練/員工': 'green', '行政櫃檯': 'gold' };

export default function CustomerParentsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [parents, setParents] = useState(null);
  const [venues, setVenues] = useState([]);
  const [filters, setFilters] = useState(() => ({
    ...EMPTY_FILTERS,
    phone: searchParams.get('phone') || '',
    name: searchParams.get('name') || '',
  }));
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState(null);   // { parent, students } | { isNew, parent, students }
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(null);  // parent pending activate/deactivate confirm
  const [toggleBusy, setToggleBusy] = useState(false);

  useEffect(() => { venuesApi.list().then(setVenues).catch(() => setVenues([])); }, []);

  const venueMap = useMemo(() => Object.fromEntries(venues.map((v) => [v.id, v.name])), [venues]);

  function reload() {
    customerParentsApi.list(filters).then(setParents).catch(() => {
      setParents([]); toast.error('讀取家長清單失敗');
    });
  }
  useEffect(() => {
    let cancel = false;
    customerParentsApi.list(filters).then((d) => { if (!cancel) setParents(d); }).catch(() => { if (!cancel) setParents([]); });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  async function openEditor(row) {
    // 先抓 detail（含學員子表）再開窗，避免子表掛載後才到、永遠空白。
    // 一律用 reveal=true 抓：點「編輯」本身就是有明確對象、可稽核的操作，不用先在列表層級
    // 按過「顯示個資」才能編輯——列表顯示的遮罩跟這裡分開，不受影響。
    let data = { parent: { ...row }, students: [] };
    try {
      const detail = await customerParentsApi.get(row.id, true);
      if (detail) data = { parent: detail, students: detail.students || [] };
    } catch { /* detail 失敗 → 用列表基本資料，不阻擋編輯 */ }
    setEditing(data);
  }

  async function handleSave(parent, students) {
    setBusy(true);
    try {
      await customerParentsApi.update(parent.id, {
        name: parent.name, phone: parent.phone, gender: parent.gender, email: parent.email,
        primary_venue_id: parent.primary_venue_id, identity: parent.identity,
        home_phone: parent.home_phone, home_address: parent.home_address, line_id: parent.line_id,
        students,
      });
      toast.success('已更新家長與學員（本地鏡像）');
      setEditing(null);
      reload();
    } catch (err) {
      toast.error(err?.response?.data?.error || '儲存失敗');
    } finally {
      setBusy(false);
    }
  }

  async function confirmToggle() {
    if (!toggling) return;
    setToggleBusy(true);
    const next = !toggling.is_active;
    try {
      await customerParentsApi.update(toggling.id, { is_active: next });
      toast.success(`家長 ${toggling.name} 已${next ? '啟用' : '停用'}`);
      setToggling(null);
      reload();
    } catch (err) {
      toast.error(err?.response?.data?.error || '狀態切換失敗');
    } finally {
      setToggleBusy(false);
    }
  }

  if (!parents) return <LoadingSpinner fullPage />;

  const columns = [
    { key: 'ragic', label: 'RAGIC / 系統 UID', render: (r) => (
      <div>
        <div className="font-mono text-[10px] text-gray-400">Node: {r.ragic_record_id || '未關聯'}</div>
        <div className="font-mono text-xs text-gray-600" title={r.id}>{String(r.id).slice(0, 12)}…</div>
      </div>
    ) },
    { key: 'name', label: '家長姓名', render: (r) => (
      <span className="font-medium">{r.name}<span className="ml-1 text-xs text-gray-400">{r.gender}</span></span>
    ) },
    { key: 'identity', label: '角色身份', render: (r) => (
      <StatusBadge tone={IDENTITY_TONE[r.identity] || 'primary'}>{r.identity || '一般身份'}</StatusBadge>
    ) },
    { key: 'venue', label: '場館', render: (r) => (
      <span className="rounded-full bg-brand-teal/10 px-2 py-0.5 text-xs font-medium text-brand-primary">
        {venueMap[r.primary_venue_id] || r.primary_venue_id || '未設'}
      </span>
    ) },
    { key: 'contact', label: '電話 / Email', render: (r) => (
      <div><div className="font-medium text-gray-800">{r.phone}</div><div className="text-[11px] text-gray-400">{r.email}</div></div>
    ) },
    { key: 'line', label: 'LINE 綁定', className: 'text-center', render: (r) => (
      r.line_bound ? <StatusBadge tone="green">已綁定</StatusBadge> : <StatusBadge tone="gray">未綁定</StatusBadge>
    ) },
    { key: 'students', label: '學員', className: 'text-center', render: (r) => (
      r.student_count > 0 ? (
        <button type="button"
          onClick={() => navigate(`/customer-students?parentId=${r.id}`)}
          className="rounded-full bg-brand-teal/10 px-2.5 py-1 text-xs font-bold text-brand-teal hover:bg-brand-teal hover:text-white">
          {r.student_count} 位 →
        </button>
      ) : <span className="text-gray-300">—</span>
    ) },
    { key: 'active', label: '狀態', className: 'text-center', render: (r) => (
      <StatusBadge tone={r.is_active ? 'green' : 'errorSoft'}>{r.is_active ? '啟用中' : '已停用'}</StatusBadge>
    ) },
    { key: 'synced', label: 'Ragic 同步', className: 'text-center', render: (r) => (
      <span className="font-mono text-[11px] text-gray-400">{r.last_synced_at || '未同步'}</span>
    ) },
    { key: 'actions', label: '操作', className: 'text-right', render: (r) => (
      <div className="space-x-2 whitespace-nowrap">
        <button className="text-xs font-medium text-brand-teal hover:underline" onClick={() => openEditor(r)}>編輯</button>
        {r.is_active ? (
          <button className="text-xs font-medium text-brand-amber hover:underline" onClick={() => setToggling(r)}>停用</button>
        ) : r.line_bound ? (
          <button className="text-xs font-medium text-brand-green hover:underline" onClick={() => setToggling(r)}>啟用</button>
        ) : (
          <span className="text-xs text-gray-300" title="未綁定 LINE 的家長無法啟用；請客戶完成 LINE 註冊綁定">未綁定不可啟用</span>
        )}
      </div>
    ) },
  ];

  const filterFields = [
    { key: 'status', label: '啟用狀態', type: 'select', options: [
      { value: 'all', label: '全部' }, { value: 'active', label: '啟用中' }, { value: 'inactive', label: '已停用' }] },
    { key: 'venueId', label: '所屬場館', type: 'combo',
      options: venues.map((v) => ({ value: v.id, label: `${v.id} ${v.name}` })), placeholder: '可輸入或選擇' },
    { key: 'name', label: '姓名', type: 'input', placeholder: '關鍵字' },
    { key: 'identity', label: '角色身份', type: 'select', options: [
      { value: '', label: '全部' }, { value: '一般身份', label: '一般身份' },
      { value: '教練/員工', label: '教練 / 員工' }, { value: '行政櫃檯', label: '行政櫃檯' }] },
    { key: 'phone', label: '電話', type: 'input', placeholder: '末 4 碼或全號' },
  ];

  return (
    <div>
      <PageHeader
        title="Z01 家長 & 學員關係管理"
        subtitle="F-A02C · 客戶登入真相鏡像；點「編輯」進入仿 Ragic 表單格線（含學員子表）。客服可於此查綁定、改綁、停用。"
        actions={(
          <div className="flex gap-2">
            <button type="button" onClick={() => setReveal((v) => !v)}
              className={`rounded-lg px-4 py-2 text-sm font-bold ${reveal ? 'bg-brand-error-soft text-brand-error-strong' : 'border border-gray-300 text-gray-600 hover:border-brand-teal'}`}>
              {reveal ? '🙈 遮蔽個資' : '👁 顯示個資'}
            </button>
            {/* 「新增家長」已依政策移除：家長一律於 Ragic Z01 建檔，
                客戶完成 LINE 註冊綁定後自動進入本鏡像（後端 POST 也已回 410）。 */}
          </div>
        )}
      />
      <FilterBar fields={filterFields} values={filters} onChange={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} />
      <DataTable columns={columns} rows={parents} rowKey={(r) => r.id} empty="沒有符合條件的家長帳號" />

      {editing && (
        <RagicZ01Modal
          isNew={!!editing.isNew}
          parent={editing.parent}
          students={editing.students}
          venues={venues}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        open={!!toggling}
        title={toggling?.is_active ? '確認停用家長帳號' : '確認啟用家長帳號'}
        confirmLabel={toggling?.is_active ? '確認停用' : '確認啟用'}
        tone={toggling?.is_active ? 'danger' : 'primary'}
        busy={toggleBusy}
        onCancel={() => !toggleBusy && setToggling(null)}
        onConfirm={confirmToggle}
      >
        {toggling && (
          toggling.is_active
            ? <p>停用家長「<b>{toggling.name}</b>」後，該家長將無法以 LINE 登入。旗下學員資料仍保留，但請確認是否影響使用。</p>
            : <p>重新啟用家長「<b>{toggling.name}</b>」，恢復其 LINE 登入權限。</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
