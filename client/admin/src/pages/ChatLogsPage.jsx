import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { adminChatApi } from '../api/chat';

const COURSE_LABEL = { 1: '1v1', 2: '1v2', 3: '1v3' };

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function MessageItem({ m }) {
  const sideMine = m.sender_type === 'coach';
  return (
    <div className={`flex ${sideMine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[70%] rounded-xl px-3 py-2 text-sm shadow-sm ${
        sideMine ? 'bg-brand-teal text-white' : 'bg-white text-gray-800 border border-gray-200'
      }`}>
        <div className={`mb-0.5 text-[11px] font-bold ${sideMine ? 'text-white/85' : 'text-brand-primary'}`}>
          {sideMine ? '教練' : '家長'}
        </div>
        {m.message_type === 'text' ? (
          <div className="whitespace-pre-wrap break-words">{m.content}</div>
        ) : m.message_type === 'image' ? (
          <a href={m.media_url} target="_blank" rel="noreferrer">
            <img src={m.media_url} alt="" className="max-h-48 max-w-full rounded" />
          </a>
        ) : (
          <a href={m.media_url} target="_blank" rel="noreferrer" className="underline">
            📎 {m.media_filename || '附件'}
          </a>
        )}
        <div className={`mt-1 text-[10px] ${sideMine ? 'text-white/70' : 'text-gray-400'}`}>
          {fmtDate(m.created_at)}
        </div>
      </div>
    </div>
  );
}

export default function ChatLogsPage() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [rooms, setRooms] = useState(null);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMsg, setLoadingMsg] = useState(false);

  function reload() {
    setRooms(null);
    adminChatApi.listRooms({ search: search.trim() || undefined })
      .then((r) => setRooms(Array.isArray(r) ? r : []))
      .catch((e) => { setRooms([]); toast.error(e?.response?.data?.error || e.message); });
  }

  useEffect(reload, []); // eslint-disable-line

  function selectRoom(r) {
    setSelected(r);
    setMessages([]);
    setLoadingMsg(true);
    adminChatApi.listMessages(r.id, { limit: 200 })
      .then((res) => {
        // 後端回 { room, messages }；mock 回 array
        const list = Array.isArray(res) ? res : (res?.messages || []);
        setMessages(list);
      })
      .catch((e) => toast.error(e?.response?.data?.error || e.message))
      .finally(() => setLoadingMsg(false));
  }

  function exportRoom() {
    if (!selected) return;
    const payload = {
      room: selected,
      exported_at: new Date().toISOString(),
      messages,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `chat-${selected.id}.json`;
    a.click(); URL.revokeObjectURL(url);
    toast.success('已匯出對話紀錄');
  }

  const columns = useMemo(() => [
    { key: 'pair', label: '教練 / 家長', render: (r) => (
      <div className="text-xs">
        <div className="font-bold text-brand-primary">教練：{r.coach?.name || '—'}</div>
        <div className="text-gray-600">家長學生：{(r.student_names || []).join('、') || '—'}</div>
      </div>
    )},
    { key: 'venue', label: '場館', render: (r) => r.venue?.name || '—' },
    { key: 'course_type', label: '課程', render: (r) => COURSE_LABEL[r.course_type] || `1v${r.course_type}` },
    { key: 'period_status', label: '期數狀態', render: (r) => <StatusBadge tone="teal" label={r.period_status} /> },
    { key: 'last', label: '最後訊息', render: (r) => fmtDate(r.last_message?.created_at) },
    { key: 'op', label: '操作', render: (r) => (
      <button type="button" onClick={() => selectRoom(r)}
        className="rounded-md bg-brand-teal px-3 py-1 text-xs font-bold text-white hover:opacity-90">
        查閱
      </button>
    )},
  ], []);

  return (
    <div>
      <PageHeader title="聊天監察 (F-M03)" subtitle="主管可查閱所有教練×家長聊天紀錄並匯出。" />

      <div className="mb-3 flex items-center gap-2">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && reload()}
          placeholder="搜尋：教練 / 場館 / 期數 ID"
          className="w-72 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-brand-teal focus:outline-none" />
        <button type="button" onClick={reload}
          className="rounded-md bg-brand-primary px-3 py-1.5 text-sm font-bold text-white hover:opacity-90">查詢</button>
      </div>

      {!rooms ? <LoadingSpinner /> : (
        <DataTable columns={columns} rows={rooms} emptyText="目前尚無聊天室" />
      )}

      {selected && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setSelected(null)}>
          <div onClick={(e) => e.stopPropagation()} className="flex h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl">
            <header className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <div className="text-sm font-bold text-brand-primary">{selected.coach?.name} ↔ {(selected.student_names || []).join('、')}</div>
                <div className="text-xs text-gray-500">{selected.venue?.name} · {COURSE_LABEL[selected.course_type]}</div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={exportRoom}
                  className="rounded-md border border-brand-primary px-3 py-1 text-xs font-bold text-brand-primary hover:bg-brand-primary/5">
                  匯出 JSON
                </button>
                <button type="button" onClick={() => setSelected(null)}
                  className="rounded-md bg-gray-200 px-3 py-1 text-xs font-bold text-gray-700">關閉</button>
              </div>
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto bg-gray-50 p-3">
              {loadingMsg ? <LoadingSpinner /> :
                messages.length === 0 ? <div className="py-8 text-center text-xs text-gray-400">尚無訊息</div> :
                messages.map((m) => <MessageItem key={m.id} m={m} />)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
