import { http, callApi, USE_MOCK } from './client';
import { mockDb } from './mock';

// ── 房間清單 ────────────────────────────────
export function listRooms() {
  return callApi('/chat/rooms', {}, () => mockDb.chatRooms());
}

export function getRoom(roomId) {
  return callApi(`/chat/rooms/${roomId}`, {}, () => mockDb.chatRoom(roomId));
}

export function listMessages(roomId, { before, limit } = {}) {
  return callApi(
    `/chat/rooms/${roomId}/messages`,
    { params: { before, limit } },
    () => mockDb.chatMessages(roomId, { before, limit })
  );
}

export function sendText(roomId, content) {
  return callApi(
    `/chat/rooms/${roomId}/messages`,
    { method: 'post', data: { content } },
    () => mockDb.chatSendText(roomId, content)
  );
}

export function markRead(roomId, messageIds) {
  return callApi(
    `/chat/rooms/${roomId}/read`,
    { method: 'post', data: { message_ids: messageIds } },
    () => mockDb.chatMarkRead(roomId, messageIds)
  );
}

// ── 多媒體上傳 ─────────────────────────────
export async function uploadFile(roomId, file, caption = '') {
  if (USE_MOCK) {
    return mockDb.chatUploadFile(roomId, file, caption);
  }
  const fd = new FormData();
  fd.append('file', file);
  if (caption) fd.append('caption', caption);
  const res = await http.post(`/chat/rooms/${roomId}/upload`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  });
  return res.data;
}

// ── WebSocket 訂閱 ──────────────────────────
// 取得目前登入者的 JWT（與 axios interceptor 同一份）
function _readToken() {
  try {
    const raw = localStorage.getItem('daos.user');
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u?.token || u?.data?.token || null;
  } catch { return null; }
}

export function subscribeRoom(roomId, { onMessage, onRead, onPresence } = {}) {
  if (USE_MOCK) {
    // mock 模式無真連線：回傳 noop close
    return { close: () => {} };
  }
  const token = _readToken();
  if (!token) return { close: () => {} };
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}&room=${encodeURIComponent(roomId)}`;
  const ws = new WebSocket(url);
  let closed = false;
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.type === 'message' && onMessage) onMessage(m.data);
      else if (m.type === 'read' && onRead) onRead(m.data);
      else if (m.type === 'presence' && onPresence) onPresence(m.data);
    } catch { /* ignore */ }
  };
  // 30s ping 防中斷
  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 30000);
  ws.onclose = () => { closed = true; clearInterval(pingTimer); };
  ws.onerror = () => { /* 後端會 close */ };
  return {
    close: () => { if (!closed) { try { ws.close(); } catch {} } clearInterval(pingTimer); },
    socket: ws,
  };
}
