import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { sessionsApi } from '../api/sessions';
import { venuesApi } from '../api/venues';
import { formatTWDate, formatTWDateTime } from '../utils/format';

export default function RevivePage() {
  const toast = useToast();
  const { isStaff } = useAuth();
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [target, setTarget] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const [data, vs] = await Promise.all([
      sessionsApi.cancelled(),
      venuesApi.list(),
    ]);
    setList(data); setVenues(vs);
  }
  useEffect(() => { load(); }, []);

  if (!list) return <LoadingSpinner fullPage />;

  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;

  async function doRevive() {
    if (!target) return;
    setBusy(true);
    try {
      if (!reason.trim()) {
        toast.error('請填寫歸還原因');
        return;
      }
      await sessionsApi.revive(target.id, reason.trim());
      toast.success(`已將課堂 ${target.id} 歸還 1 堂`);
      setTarget(null);
      setReason('');
      await load();
    } catch {
      toast.error('復活失敗');
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: 'id', label: '時段編號', render: (r) => <span className="font-mono text-xs">{r.id}</span> },
    { key: 'date', label: '原排定日期（台北）', render: (r) => formatTWDate(r.date) },
    { key: 'start', label: '時間（台北）', render: (r) => <span className="font-mono">{r.start}</span> },
    { key: 'period_id', label: '所屬報名', render: (r) => <span className="font-mono text-xs">{r.period_id}</span> },
    { key: 'parent_name', label: '家長' },
    { key: 'students', label: '到課學員', render: (r) => (r.students || []).join('、') || '—' },
    { key: 'coach', label: '教練' },
    { key: 'venue_id', label: '場館', render: (r) => venueName(r.venue_id) },
    {
      key: 'refunded', label: '狀態',
      render: (r) => r.refunded
        ? <StatusBadge tone="green">已歸還</StatusBadge>
        : <StatusBadge tone="amber">尚未處理</StatusBadge>,
    },
    {
      key: 'reversal_audit', label: '歸還紀錄（台北）',
      render: (r) => r.refunded && r.reversed_at
        ? (
          <div className="max-w-xs text-xs text-gray-600">
            <div>{formatTWDateTime(r.reversed_at)} · {r.reversed_by || '—'}</div>
            <div className="truncate" title={r.reversal_reason || ''}>{r.reversal_reason || '—'}</div>
          </div>
        )
        : '—',
    },
    {
      key: 'actions', label: '操作', className: 'text-right',
      render: (r) => (isStaff || r.refunded)
        ? <span className="text-xs text-gray-400">—</span>
        : (
          <button
            className="rounded-md bg-brand-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-teal"
            onClick={() => { setTarget(r); setReason(''); }}
          >
            歸還堂數
          </button>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="扣課復活"
        subtitle={isStaff
          ? 'F-M05 · 櫃台僅供查詢，堂數歸還由主管處理'
          : 'F-M05 · 主管權限。將已扣除但未實際上課的堂數歸還給家長'}
      />
      <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="目前沒有需要處理的時段" />

      <ConfirmDialog
        open={!!target}
        title="確認歸還堂數？"
        confirmLabel="確認歸還"
        onCancel={() => { setTarget(null); setReason(''); }}
        onConfirm={doRevive}
        busy={busy}
      >
        {target && (
          <div className="space-y-1 text-sm">
            <div>時段 <b className="font-mono">{target.id}</b>（台北時間 {formatTWDate(target.date)} {target.start}）</div>
            <div>所屬課期 <b className="font-mono">{target.period_id}</b>（{target.parent_name}）</div>
            {!!target.students?.length && <div>到課學員：<b>{target.students.join('、')}</b></div>}
            <label className="mt-3 block text-xs font-medium text-gray-600">歸還原因 *</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              rows={3}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="請填寫實際未上課或更正原因"
            />
            <div className="mt-3 rounded bg-brand-amber/10 p-2 text-xs text-brand-amber">
              系統只歸還這個共享 session 的 1 堂，並保留全部 attendance 與操作者稽核紀錄。
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
