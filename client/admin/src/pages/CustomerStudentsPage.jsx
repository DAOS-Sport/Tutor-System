import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import FilterBar from '../components/FilterBar';
import ConfirmDialog from '../components/ConfirmDialog';
import RagicZ02Modal from './RagicZ02Modal';
import { useToast } from '../context/ToastContext';
import { customerStudentsApi } from '../api/customers';
import { maskIdNumber, maskBloodType } from '../utils/pii';

const EMPTY_FILTERS = { name: '', gender: '', code: '', parentId: '' };

export default function CustomerStudentsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [students, setStudents] = useState(null);
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS, parentId: searchParams.get('parentId') || '' }));
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  const listParams = () => ({ ...filters, reveal: reveal ? 1 : undefined });
  function reload() {
    customerStudentsApi.list(listParams()).then(setStudents).catch(() => { setStudents([]); toast.error('讀取學員清單失敗'); });
  }
  useEffect(() => {
    let cancel = false;
    // reveal 進 deps：切換「顯示個資」會重新向後端取（後端依 reveal 回原值/遮罩 + 寫稽核）
    customerStudentsApi.list(listParams()).then((d) => { if (!cancel) setStudents(d); }).catch(() => { if (!cancel) setStudents([]); });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, reveal]);

  const parentChipName = filters.parentId ? (students?.find((s) => s.parent_id === filters.parentId)?.parent_name || '') : '';

  function clearParentFilter() {
    setFilters((f) => ({ ...f, parentId: '' }));
    searchParams.delete('parentId');
    setSearchParams(searchParams, { replace: true });
  }

  async function openEditor(row) {
    // 先抓 detail（含購買紀錄）再開窗，避免購買紀錄掛載後才到、永遠空白。
    // 一律用 reveal=true 抓：點「編輯」本身就是有明確對象、可稽核的操作，不用先在列表層級
    // 按過「顯示個資」才能編輯——列表顯示的遮罩（下方 DataTable 欄位）跟這裡分開，不受影響。
    let data = { ...row, purchases: [] };
    try {
      const detail = await customerStudentsApi.get(row.id, true);
      if (detail) data = detail;
    } catch { /* detail 失敗 → 用列表基本資料 */ }
    setEditing(data);
  }

  async function handleSave(student) {
    setBusy(true);
    try {
      await customerStudentsApi.update(student.id, {
        name: student.name, gender: student.gender, birth_date: student.birth_date,
        id_number: student.id_number, blood_type: student.blood_type, student_code: student.student_code,
      });
      toast.success('已更新學員（本地鏡像）');
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
      await customerStudentsApi.update(toggling.id, { is_active: next });
      toast.success(`學員 ${toggling.name} 已${next ? '恢復在籍' : '停用'}`);
      setToggling(null);
      reload();
    } catch (err) {
      toast.error(err?.response?.data?.error || '狀態切換失敗');
    } finally {
      setToggleBusy(false);
    }
  }

  if (!students) return <LoadingSpinner fullPage />;

  const columns = [
    { key: 'student_code', label: '學員編號', render: (r) => <span className="font-mono font-bold text-gray-800">{r.student_code || '—'}</span> },
    { key: 'name', label: '學員姓名', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'gender', label: '性別', render: (r) => (
      <span className={`rounded-full px-2 py-0.5 text-[11px] ${r.gender === '生理男' ? 'bg-blue-50 text-blue-600' : 'bg-pink-50 text-pink-600'}`}>{r.gender || '—'}</span>
    ) },
    { key: 'birth_date', label: '出生年月日', render: (r) => <span className="font-mono text-gray-600">{r.birth_date || '—'}</span> },
    { key: 'id_number', label: '身分證字號', render: (r) => <span className="font-mono tracking-wider text-gray-700">{maskIdNumber(r.id_number, reveal)}</span> },
    { key: 'blood_type', label: '血型', render: (r) => <span className="font-mono text-gray-700">{maskBloodType(r.blood_type, reveal)}</span> },
    { key: 'parent', label: '關聯家長', render: (r) => (
      r.parent_name ? (
        <button type="button" onClick={() => navigate(`/customer-parents?phone=${r.parent_phone || ''}`)}
          className="font-medium text-brand-teal hover:underline">
          {r.parent_name}<span className="ml-1 text-[10px] text-gray-400">{r.parent_phone}</span> →
        </button>
      ) : <StatusBadge tone="errorSoft">未綁定家長</StatusBadge>
    ) },
    { key: 'active', label: '學籍', className: 'text-center', render: (r) => (
      <StatusBadge tone={r.is_active ? 'green' : 'errorSoft'}>{r.is_active ? '在籍中' : '休/退學'}</StatusBadge>
    ) },
    { key: 'synced', label: 'Ragic 同步', className: 'text-center', render: (r) => <span className="font-mono text-[11px] text-gray-400">{r.last_synced_at || '未同步'}</span> },
    { key: 'actions', label: '操作', className: 'text-right', render: (r) => (
      <div className="space-x-2 whitespace-nowrap">
        <button className="text-xs font-medium text-brand-teal hover:underline" onClick={() => openEditor(r)}>編輯 / 購買紀錄</button>
        <button className={`text-xs font-medium hover:underline ${r.is_active ? 'text-brand-amber' : 'text-brand-green'}`} onClick={() => setToggling(r)}>{r.is_active ? '停用' : '啟用'}</button>
      </div>
    ) },
  ];

  const filterFields = [
    { key: 'name', label: '學員姓名', type: 'input', placeholder: '關鍵字' },
    { key: 'gender', label: '性別', type: 'select', options: [
      { value: '', label: '全部' }, { value: '生理男', label: '生理男' }, { value: '生理女', label: '生理女' }] },
    { key: 'code', label: '學員編號 / 身分證', type: 'input', placeholder: '編號或身分證' },
  ];

  return (
    <div>
      <PageHeader
        title="Z02 學員資料管理（含購買紀錄查詢）"
        subtitle="F-A02C · 新增學員請至「Z01 家長 & 學員關係」家長子表綁定。此頁修改學籍、查購買紀錄。"
        actions={(
          <button type="button" onClick={() => setReveal((v) => !v)}
            className={`rounded-lg px-4 py-2 text-sm font-bold ${reveal ? 'bg-brand-error-soft text-brand-error-strong' : 'border border-gray-300 text-gray-600 hover:border-brand-teal'}`}>
            {reveal ? '🙈 遮蔽個資' : '👁 顯示個資'}
          </button>
        )}
      />

      {filters.parentId && (
        <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-brand-teal/10 px-3 py-1 text-xs font-bold text-brand-primary">
          家長過濾：{parentChipName || filters.parentId}
          <button type="button" onClick={clearParentFilter} className="text-brand-error hover:font-black">✕</button>
        </div>
      )}

      <FilterBar fields={filterFields} values={filters} onChange={setFilters} onReset={() => setFilters({ ...EMPTY_FILTERS })} />
      <DataTable columns={columns} rows={students} rowKey={(r) => r.id} empty="沒有符合條件的學員" />

      {editing && (
        <RagicZ02Modal student={editing} busy={busy} onClose={() => setEditing(null)} onSave={handleSave} />
      )}

      <ConfirmDialog
        open={!!toggling}
        title={toggling?.is_active ? '確認停用學員學籍' : '確認恢復學員學籍'}
        confirmLabel={toggling?.is_active ? '確認停用' : '確認恢復'}
        tone={toggling?.is_active ? 'danger' : 'primary'}
        busy={toggleBusy}
        onCancel={() => !toggleBusy && setToggling(null)}
        onConfirm={confirmToggle}
      >
        {toggling && <p>將學員「<b>{toggling.name}</b>」變更為 <b>{toggling.is_active ? '休/退學' : '在籍中'}</b>，會影響日常扣課與簽到。</p>}
      </ConfirmDialog>
    </div>
  );
}
