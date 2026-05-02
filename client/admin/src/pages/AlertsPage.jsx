import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { adminAlertsApi } from '../api/chat';

const STATUS_OPTIONS = [
  { v: 'pending',   label: '待處理',   tone: 'orange' },
  { v: 'reviewed',  label: '已查閱',   tone: 'teal' },
  { v: 'no_issue',  label: '判定無虞', tone: 'green' },
  { v: 'resolved',  label: '已處理',   tone: 'primary' },
];
const STATUS_TONE = Object.fromEntries(STATUS_OPTIONS.map((o) => [o.v, o.tone]));
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map((o) => [o.v, o.label]));
const NEXT_STATUS_OPTIONS = STATUS_OPTIONS.filter((s) => s.v !== 'pending');

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function AlertsPage() {
  const { toast } = useToast();
  const [filter, setFilter] = useState('pending');
  const [list, setList] = useState(null);

  function reload(f = filter) {
    setList(null);
    const params = f === 'all' ? {} : { status: f };
    adminAlertsApi.list(params)
      .then((r) => setList(Array.isArray(r) ? r : []))
      .catch((e) => { setList([]); toast(e?.response?.data?.error || e.message, 'error'); });
  }

  useEffect(() => { reload(filter); }, [filter]); // eslint-disable-line

  async function handleAck(id, status) {
    try {
      await adminAlertsApi.update(id, { status });
      toast(`已更新為「${STATUS_LABEL[status]}」`, 'success');
      reload();
    } catch (e) { toast(e?.response?.data?.error || '更新失敗', 'error'); }
  }

  const columns = [
    { key: 'created_at', label: '觸發時間', render: (r) => fmt(r.created_at) },
    { key: 'triggered_keyword', label: '關鍵字', render: (r) => (
      <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-bold text-red-700">{r.triggered_keyword}</span>
    )},
    { key: 'context', label: '教練 / 場館', render: (r) => (
      <div className="text-xs">
        <div className="font-bold text-brand-primary">{r.coach_name || '—'}</div>
        <div className="text-gray-600">{r.venue_name || '—'}</div>
      </div>
    )},
    { key: 'snippet', label: '訊息內容', render: (r) => (
      <div className="max-w-sm">
        <div className="truncate text-xs text-gray-700">{r.message_content || '—'}</div>
        <div className="text-[10px] text-gray-400">
          {r.sender_type === 'parent' ? '家長發出' : '教練發出'} · {fmt(r.message_at)}
        </div>
      </div>
    )},
    { key: 'status', label: '狀態', render: (r) => (
      <StatusBadge tone={STATUS_TONE[r.status] || 'teal'} label={STATUS_LABEL[r.status] || r.status} />
    )},
    { key: 'op', label: '操作', render: (r) => (
      r.status !== 'pending' && r.reviewed_at ? (
        <span className="text-xs text-gray-400">{fmt(r.reviewed_at)}</span>
      ) : (
        <select defaultValue="" onChange={(e) => e.target.value && handleAck(r.id, e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs">
          <option value="" disabled>選擇處理…</option>
          {NEXT_STATUS_OPTIONS.map((s) => (
            <option key={s.v} value={s.v}>{s.label}</option>
          ))}
        </select>
      )
    )},
  ];

  return (
    <div>
      <PageHeader title="關鍵字警示" subtitle="當聊天訊息觸發關鍵字，主管即可在此查閱、判定並結案。" />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {[{ v: 'pending', label: '待處理' }, { v: 'reviewed', label: '已查閱' },
          { v: 'no_issue', label: '判定無虞' }, { v: 'resolved', label: '已處理' },
          { v: 'all', label: '全部' }].map((b) => (
          <button key={b.v} type="button" onClick={() => setFilter(b.v)}
            className={`rounded-full px-3 py-1 text-xs font-bold transition ${
              filter === b.v ? 'bg-brand-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}>
            {b.label}
          </button>
        ))}
      </div>

      {!list ? <LoadingSpinner /> : (
        <DataTable columns={columns} rows={list} emptyText="目前沒有警示" />
      )}
    </div>
  );
}
