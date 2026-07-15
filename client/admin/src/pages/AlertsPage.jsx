import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { adminAlertsApi } from '../api/chat';
import { formatTWDateTime } from '../utils/format';

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
  return formatTWDateTime(iso);
}

export default function AlertsPage() {
  const toast = useToast();
  const [filter, setFilter] = useState('pending');
  const [allList, setAllList] = useState(null);

  // 一次抓全部狀態，分頁切換前端過濾，讓每個分頁都能顯示正確筆數
  function reload() {
    setAllList(null);
    adminAlertsApi.list({})
      .then((r) => setAllList(Array.isArray(r) ? r : []))
      .catch((e) => { setAllList([]); toast.error(e?.response?.data?.error || e.message); });
  }

  useEffect(() => { reload(); }, []); // eslint-disable-line

  const counts = useMemo(() => {
    const c = { all: 0, pending: 0, reviewed: 0, no_issue: 0, resolved: 0 };
    if (Array.isArray(allList)) {
      c.all = allList.length;
      for (const r of allList) c[r.status] = (c[r.status] || 0) + 1;
    }
    return c;
  }, [allList]);

  const list = useMemo(() => {
    if (!Array.isArray(allList)) return null;
    return filter === 'all' ? allList : allList.filter((r) => r.status === filter);
  }, [allList, filter]);

  const [editing, setEditing] = useState(null); // { id, status, note }

  async function submitReview() {
    if (!editing) return;
    try {
      await adminAlertsApi.update(editing.id, {
        status: editing.status,
        review_note: editing.note?.trim() || undefined,
      });
      toast.success(`已更新為「${STATUS_LABEL[editing.status]}」`);
      setEditing(null);
      reload();
    } catch (e) { toast.error(e?.response?.data?.error || '更新失敗'); }
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
    { key: 'review_note', label: '處理結果', render: (r) => (
      r.review_note
        ? <div className="max-w-xs whitespace-pre-wrap text-xs text-gray-700">{r.review_note}</div>
        : <span className="text-xs text-gray-400">—</span>
    )},
    { key: 'op', label: '操作', render: (r) => (
      r.status !== 'pending' && r.reviewed_at ? (
        <button type="button" onClick={() => setEditing({ id: r.id, status: r.status, note: r.review_note || '' })}
          className="text-xs text-brand-teal underline">{fmt(r.reviewed_at)} · 修改</button>
      ) : (
        <button type="button" onClick={() => setEditing({ id: r.id, status: 'reviewed', note: '' })}
          className="rounded-md bg-brand-teal px-3 py-1 text-xs font-bold text-white hover:opacity-90">處理</button>
      )
    )},
  ];

  return (
    <div>
      <PageHeader title="關鍵字警示" subtitle="當聊天訊息觸發關鍵字，主管即可在此查閱、判定並結案。" />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {[{ v: 'all', label: '全部' }, { v: 'pending', label: '待處理' }, { v: 'reviewed', label: '已查閱' },
          { v: 'no_issue', label: '判定無虞' }, { v: 'resolved', label: '已處理' },
        ].map((b) => (
          <button key={b.v} type="button" onClick={() => setFilter(b.v)}
            className={`rounded-full px-3 py-1 text-xs font-bold transition ${
              filter === b.v ? 'bg-brand-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}>
            {b.label}（{Array.isArray(allList) ? (b.v === 'all' ? counts.all : counts[b.v] || 0) : '…'}）
          </button>
        ))}
      </div>

      {!list ? <LoadingSpinner /> : (
        <DataTable columns={columns} rows={list} emptyText="目前沒有警示" />
      )}

      {editing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="mb-3 text-base font-bold text-brand-primary">處理警示</h3>
            <label className="mb-2 block text-xs font-bold text-gray-600">處理結果（review_note）</label>
            <textarea rows={4} value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value.slice(0, 500) })}
              placeholder="補充判定理由 / 已聯絡家長 / 教練回報… (最多 500 字)"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none" />
            <label className="mb-2 mt-3 block text-xs font-bold text-gray-600">狀態</label>
            <select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
              {NEXT_STATUS_OPTIONS.map((s) => (
                <option key={s.v} value={s.v}>{s.label}</option>
              ))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(null)} className="rounded-md bg-gray-200 px-3 py-2 text-xs font-bold text-gray-700">取消</button>
              <button type="button" onClick={submitReview} className="rounded-md bg-brand-primary px-3 py-2 text-xs font-bold text-white hover:opacity-90">儲存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
