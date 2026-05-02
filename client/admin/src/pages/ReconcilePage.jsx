import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { enrollmentsApi } from '../api/enrollments';
import { venuesApi } from '../api/venues';
import { formatTWD, formatTWDateTime, courseTypeLabel } from '../utils/format';

export default function ReconcilePage() {
  const toast = useToast();
  const { user, isStaff } = useAuth();
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const venueId = isStaff ? user?.venue_id : undefined;
    const [data, vs] = await Promise.all([
      enrollmentsApi.list({ status: 'pending_payment', venueId }),
      venuesApi.list(),
    ]);
    setList(data); setVenues(vs);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  if (!list) return <LoadingSpinner fullPage />;

  async function doReconcile() {
    if (!confirming) return;
    setBusy(true);
    try {
      await enrollmentsApi.reconcile(confirming.id, user.name);
      toast.success(`已對帳通過 ${confirming.id}`);
      setConfirming(null);
      await load();
    } catch {
      toast.error('對帳失敗');
    } finally {
      setBusy(false);
    }
  }

  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;

  const columns = [
    { key: 'id', label: '報名編號', render: (r) => <span className="font-mono text-xs">{r.id}</span> },
    { key: 'submitted_at', label: '送出時間', render: (r) => <span className="text-xs text-gray-600">{formatTWDateTime(r.submitted_at)}</span> },
    { key: 'parent', label: '家長', render: (r) => <div><div className="font-medium">{r.parent_name}</div><div className="text-xs text-gray-500">{r.parent_phone}</div></div> },
    { key: 'students', label: '學員', render: (r) => <span className="text-sm">{r.students.join('、')}</span> },
    { key: 'coach', label: '教練 / 場館', render: (r) => <div><div>{r.coach}</div><div className="text-xs text-gray-500">{venueName(r.venue_id)}</div></div> },
    { key: 'course_type', label: '組別', render: (r) => <StatusBadge tone="teal">{courseTypeLabel(r.course_type)}</StatusBadge> },
    { key: 'final_price', label: '應收', className: 'text-right', render: (r) => <span className="font-mono">{formatTWD(r.final_price)}</span> },
    { key: 'transfer_last_5', label: '末 5 碼', className: 'text-center', render: (r) => <span className="font-mono">{r.transfer_last_5}</span> },
    {
      key: 'actions', label: '操作', className: 'text-right',
      render: (r) => (
        <button
          className="rounded-md bg-brand-green px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-teal"
          onClick={() => setConfirming(r)}
        >
          對帳通過
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="待對帳清單"
        subtitle={`F-M02 · 共 ${list.length} 筆等待對帳${isStaff ? '（限本場館）' : ''}`}
      />
      <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="目前沒有待對帳的報名" />
      <ConfirmDialog
        open={!!confirming}
        title="確認對帳通過？"
        onCancel={() => setConfirming(null)}
        onConfirm={doReconcile}
        busy={busy}
        confirmLabel="確認對帳"
      >
        {confirming && (
          <div className="space-y-1 text-sm">
            <div>報名編號：<b>{confirming.id}</b></div>
            <div>家長：{confirming.parent_name}（{confirming.parent_phone}）</div>
            <div>應收 {formatTWD(confirming.final_price)}，末 5 碼 <b>{confirming.transfer_last_5}</b></div>
            <div className="mt-3 rounded bg-brand-amber/10 p-2 text-xs text-brand-amber">
              對帳後系統將開通 {confirming.coach} 教練的課程，並透過 LINE 推播通知家長。
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
