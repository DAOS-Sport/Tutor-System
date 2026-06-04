import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { listRooms } from '../api/chat';
import LoadingSpinner from '../components/LoadingSpinner';

const COURSE_LABEL = { 1: '1v1', 2: '1v2', 3: '1v3' };

function timeOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function lastSnippet(m) {
  if (!m) return '尚無訊息';
  if (m.message_type === 'text') return m.content || '';
  if (m.message_type === 'image') return '📷 圖片';
  if (m.message_type === 'voice') return '🎤 語音';
  if (m.message_type === 'video') return '🎬 影片';
  if (m.message_type === 'file')  return `📎 ${m.media_filename || '檔案'}`;
  return '訊息';
}

export default function ChatListPage() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancel = false;
    listRooms()
      .then((r) => { if (!cancel) setRooms(Array.isArray(r) ? r : []); })
      .catch((e) => { if (!cancel) { setErr(e?.response?.data?.error || e.message); setRooms([]); } });
    return () => { cancel = true; };
  }, []);

  const baseHref = role === 'coach' ? '/coach/chat' : '/chat';

  return (
    <div className="px-4 py-4">
      <h1 className="mb-3 text-base font-bold text-brand-primary">
        {role === 'coach' ? '與家長聊天' : '與教練聊天'}
      </h1>
      {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}
      {!rooms ? <LoadingSpinner /> : rooms.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-white p-8 text-center">
          <div className="mb-2 text-3xl">💬</div>
          <p className="text-sm font-bold text-gray-700">尚無聊天室</p>
          <p className="mt-1 text-xs text-gray-500">
            {role === 'coach' ? '當家長報名並完成對帳後，將自動建立聊天室。' : '完成報名並對帳後，將自動建立與教練的聊天室。'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rooms.map((r) => {
            const peer = role === 'coach'
              ? (r.student_names || []).join('、') || '家長'
              : `${r.coach?.name || '教練'} 教練`;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => navigate(`${baseHref}/${r.id}`)}
                  className="flex w-full items-start gap-3 rounded-2xl bg-white p-3 text-left shadow-sm active:scale-[0.99]"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-teal text-base font-bold text-white">
                    {(role === 'coach' ? (r.student_names?.[0]?.[0] || '家') : (r.coach?.name?.[0] || '教'))}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-bold text-brand-primary">{peer}</span>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">
                        {COURSE_LABEL[r.course_type] || `1v${r.course_type}`} · {r.venue?.name || ''}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-gray-500">{lastSnippet(r.last_message)}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 pt-0.5">
                    <span className="text-[10px] text-gray-400">{timeOf(r.last_message?.created_at)}</span>
                    {r.unread_count > 0 && (
                      <span className="rounded-full bg-brand-orange px-1.5 py-0.5 text-[10px] font-bold text-white">
                        {r.unread_count > 99 ? '99+' : r.unread_count}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
