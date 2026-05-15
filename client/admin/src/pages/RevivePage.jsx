import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { sessionsApi } from '../api/sessions';
import { venuesApi } from '../api/venues';
import { formatTWDate } from '../utils/format';

export default function RevivePage() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [target, setTarget] = useState(null);
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
      await sessionsApi.revive(target.id);
      toast.success(`已將時段 ${target.id} 的堂數歸還給家長`);
      setTarget(null);
      await load();
    } catch {
      toast.error('復活失敗');
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: 'id', label: '時段編號', render: (r) => <span className="font-mono text-xs">{r.id}</span> },
    { key: 'date', label: '原排定日期', render: (r) => formatTWDate(r.date) },
    { key: 'start', label: '時間', render: (r) => <span className="font-mono">{r.start}</span> },
    { key: 'period_id', label: '所屬報名', render: (r) => <span className="font-mono text-xs">{r.period_id}</span> },
    { key: 'parent_name', label: '家長' },
    { key: 'coach', label: '教練' },
    { key: 'venue_id', label: '場館', render: (r) => venueName(r.venue_id) },
    {
      key: 'refunded', label: '狀態',
      render: (r) => r.refunded
        ? <StatusBadge tone="green">已歸還</StatusBadge>
        : <StatusBadge tone="amber">尚未處理</StatusBadge>,
    },
    {
      key: 'actions', label: '操作', className: 'text-right',
      render: (r) => r.refunded
        ? <span className="text-xs text-gray-400">—</span>
        : (
          <button
            className="rounded-md bg-brand-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-teal"
            onClick={() => setTarget(r)}
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
        subtitle="F-M05 · 主管權限。將已扣除但未實際上課的堂數歸還給家長"
      />
      <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="目前沒有需要處理的時段" />

      <ConfirmDialog
        open={!!target}
        title="確認歸還堂數？"
        confirmLabel="確認歸還"
        onCancel={() => setTarget(null)}
        onConfirm={doRevive}
        busy={busy}
      >
        {target && (
          <div className="space-y-1 text-sm">
            <div>時段 <b className="font-mono">{target.id}</b>（{formatTWDate(target.date)} {target.start}）</div>
            <div>所屬報名 <b className="font-mono">{target.period_id}</b>（{target.parent_name}）</div>
            <div className="mt-3 rounded bg-brand-amber/10 p-2 text-xs text-brand-amber">
              系統會將該家長已使用堂數 -1，並透過 LINE 通知。
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
