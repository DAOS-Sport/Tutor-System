import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  getRoom, listMessages, sendText, uploadFile, markRead, subscribeRoom,
} from '../api/chat';
import { courseTypeLabel, formatTWTime } from '../utils/format';

function fmtTime(iso) {
  return formatTWTime(iso);
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let n = Number(bytes), i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function FileMeta({ m, light }) {
  const cls = light ? 'text-white/75' : 'text-gray-500';
  return (
    <div className={`mt-1 text-[10px] ${cls}`}>
      {m.media_filename ? <span className="break-all">{m.media_filename}</span> : null}
      {m.media_size_bytes ? <span> · {fmtSize(m.media_size_bytes)}</span> : null}
    </div>
  );
}

function MediaBubble({ m, mine }) {
  if (m.message_type === 'image') {
    return (
      <div>
        <a href={m.media_url} target="_blank" rel="noreferrer">
          <img src={m.media_url} alt={m.media_filename || ''} className="max-h-64 max-w-full rounded-lg" />
        </a>
        <FileMeta m={m} light={mine} />
      </div>
    );
  }
  if (m.message_type === 'video') {
    return (
      <div>
        <video src={m.media_url} controls className="max-h-64 max-w-full rounded-lg" />
        <FileMeta m={m} light={mine} />
      </div>
    );
  }
  if (m.message_type === 'voice') {
    return (
      <div>
        <audio src={m.media_url} controls className="w-full" />
        <FileMeta m={m} light={mine} />
      </div>
    );
  }
  return (
    <div>
      <a href={m.media_url} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline">
        📎 {m.media_filename || '附件'}
      </a>
      <FileMeta m={m} light={mine} />
    </div>
  );
}

function senderLabel(m) {
  if (m.sender_display_name) return m.sender_display_name;
  if (m.sender_type === 'coach') return '教練';
  if (m.sender_type === 'parent') return '家長';
  return '系統';
}

export default function ChatRoomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { role, user } = useAuth();
  const myType = role; // 'parent' | 'coach'
  const myId = user?.data?.id || null;

  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const scrollRef = useRef(null);
  const wsRef = useRef(null);

  // 初始載入
  useEffect(() => {
    let cancel = false;
    Promise.all([getRoom(roomId), listMessages(roomId, { limit: 80 })])
      .then(([r, msgs]) => {
        if (cancel) return;
        setRoom(r);
        setMessages(Array.isArray(msgs) ? msgs : []);
      })
      .catch((e) => !cancel && setErr(e?.response?.data?.error || e.message));
    return () => { cancel = true; };
  }, [roomId]);

  // WebSocket 訂閱
  useEffect(() => {
    if (!roomId) return undefined;
    const sub = subscribeRoom(roomId, {
      onMessage: (m) => setMessages((prev) => prev.find((x) => x.id === m.id) ? prev : [...prev, m]),
      onRead: (data) => {
        // WS read 廣播是「對手方標已讀」事件 — 對 viewer 而言應更新 read_by_peer
        // （供自己發出去的訊息顯示「已讀」），而非更新 read_by_me。
        const isSelfEcho = data.reader_type === myType && data.reader_id === myId;
        setMessages((prev) => prev.map((m) => {
          if (!data.message_ids.includes(m.id)) return m;
          return isSelfEcho ? { ...m, read_by_me: true } : { ...m, read_by_peer: true };
        }));
      },
    });
    wsRef.current = sub;
    return () => sub.close();
  }, [roomId]);

  // 自動滾到底
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  // 進入聊天室自動標已讀（去抖）
  useEffect(() => {
    if (!messages.length) return undefined;
    const t = setTimeout(() => {
      markRead(roomId).catch(() => { /* 忽略 */ });
    }, 600);
    return () => clearTimeout(t);
  }, [roomId, messages.length]);

  const peerName = useMemo(() => {
    if (!room) return '';
    return role === 'coach'
      ? (room.student_names || []).join('、') || '家長'
      : `${room.coach?.name || '教練'} 教練`;
  }, [room, role]);

  const roomSubtitle = useMemo(() => {
    if (!room) return '';
    return [
      room.course_type ? courseTypeLabel(room.course_type) : '',
      room.venue?.name || '',
      role === 'coach' ? '' : (room.student_names || []).join('、'),
    ].filter(Boolean).join(' · ');
  }, [room, role]);

  async function handleSend(e) {
    e.preventDefault();
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    setErr(null);
    try {
      const m = await sendText(roomId, v);
      setMessages((prev) => prev.find((x) => x.id === m.id) ? prev : [...prev, m]);
      setText('');
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2.message);
    } finally { setSending(false); }
  }

  async function handleFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setSending(true); setErr(null);
    try {
      const m = await uploadFile(roomId, f, '');
      setMessages((prev) => prev.find((x) => x.id === m.id) ? prev : [...prev, m]);
    } catch (e2) {
      setErr(e2?.response?.data?.error || '上傳失敗');
    } finally { setSending(false); }
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-gray-50">
      <header className="flex h-12 items-center gap-2 border-b border-gray-100 bg-white px-3 shadow-sm">
        <button type="button" onClick={() => navigate(-1)} className="-ml-1 flex h-9 w-9 items-center justify-center text-brand-primary">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="flex-1 truncate">
          <div className="truncate text-sm font-bold text-brand-primary">{peerName}</div>
          {room && <div className="truncate text-[11px] text-gray-500">{roomSubtitle}</div>}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {err && <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}
        {messages.map((m) => {
          const mine = m.sender_type === myType && (!myId || m.sender_id === myId);
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                mine ? 'bg-brand-teal text-white' : 'bg-white text-gray-800'
              }`}>
                <div className={`mb-1 truncate text-[11px] font-bold ${mine ? 'text-white/80' : 'text-brand-primary'}`}>
                  {senderLabel(m)}
                </div>
                {m.message_type === 'text'
                  ? <span className="whitespace-pre-wrap break-words">{m.content}</span>
                  : <MediaBubble m={m} mine={mine} />}
                <div className={`mt-1 flex items-center gap-1 text-[10px] ${mine ? 'text-white/70 justify-end' : 'text-gray-400'}`}>
                  <span>{fmtTime(m.created_at)}</span>
                  {mine && m.read_by_peer && <span>· 已讀</span>}
                </div>
              </div>
            </div>
          );
        })}
        {messages.length === 0 && (
          <div className="py-8 text-center text-xs text-gray-400">這裡還沒有訊息，先說聲哈囉吧 👋</div>
        )}
      </div>

      <form onSubmit={handleSend} className="flex items-center gap-2 border-t border-gray-100 bg-white p-2">
        <button type="button" onClick={() => fileRef.current?.click()} className="flex h-10 w-10 items-center justify-center rounded-full text-brand-primary active:bg-gray-100">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <input ref={fileRef} type="file" accept="image/*,video/*,audio/*,.pdf,.docx,.xlsx" className="hidden" onChange={handleFile} />
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="輸入訊息…"
          className="flex-1 rounded-full border border-gray-200 bg-gray-50 px-4 py-2 text-sm focus:border-brand-teal focus:bg-white focus:outline-none"
        />
        <button type="submit" disabled={!text.trim() || sending}
          className="rounded-full bg-brand-teal px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
          送出
        </button>
      </form>
    </div>
  );
}
