/**
 * WebSocket 服務（聊天室即時推播）
 *
 * 連線：ws(s)://host/ws?token=<JWT>&room=<chat_room_id>
 *  - JWT 驗證：parent / coach / admin / manager / staff token（共用 JWT_SECRET）
 *  - room 授權：透過 chatRooms.canAccess 嚴格檢查
 *      · parent / coach：必須是該 period 的參與者
 *      · admin / manager / staff：依 chatRooms.canAccess（admin 全域、manager/staff 由 HTTP 端
 *        venue 範圍內已過濾的 list 取得 roomId 後訂閱）— WS 只接收訊息/已讀廣播，不寫入。
 *
 * 訊息格式（server → client）：
 *   { type: 'message',  data: { id, sender_type, sender_id, message_type, content, media_url, ... } }
 *   { type: 'read',     data: { reader_type, reader_id, message_ids:[...] } }
 *   { type: 'presence', data: { online: [{ type, id }] } }
 *
 * 對外 API：
 *   initWebSocket(server)                           — 掛載
 *   broadcastMessage(roomId, messageObj)            — 廣播新訊息給房間所有人
 *   broadcastRead(roomId, payload)                  — 廣播已讀狀態
 */
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { canAccess } = require('./chatRooms');
const { getSecret } = require('../middlewares/parentAuth');

const rooms = new Map(); // roomId → Set<ws>

function _join(roomId, ws) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);
}
function _leave(roomId, ws) {
  const set = rooms.get(roomId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(roomId);
}
function _presenceSnapshot(roomId) {
  const set = rooms.get(roomId);
  if (!set) return { online: [] };
  const seen = new Map();
  for (const c of set) {
    const k = `${c.userType}:${c.userId}`;
    if (!seen.has(k)) seen.set(k, { type: c.userType, id: c.userId });
  }
  return { online: Array.from(seen.values()) };
}
function _broadcast(roomId, payload, exclude = null) {
  const set = rooms.get(roomId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const c of set) {
    if (c !== exclude && c.readyState === WebSocket.OPEN) {
      try { c.send(data); } catch { /* ignore */ }
    }
  }
}

function initWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    let token, roomId, payload;
    try {
      const url = new URL(req.url, 'http://localhost');
      token = url.searchParams.get('token');
      roomId = url.searchParams.get('room');
      if (!token || !roomId) return ws.close(4400, 'Missing token or room');
      payload = jwt.verify(token, getSecret());
    } catch {
      return ws.close(4001, 'Invalid token');
    }

    let role, userId;
    if (payload.type === 'parent') { role = 'parent'; userId = payload.parentId; }
    else if (payload.type === 'coach') { role = 'coach'; userId = payload.coachId; }
    else if (payload.role && ['admin', 'manager', 'staff'].includes(payload.role)) {
      // admin token 走 routes/admin/auth.js 簽發，payload.role 帶角色
      role = payload.role;
      userId = payload.sub || null;
    } else {
      return ws.close(4003, 'Unsupported token type');
    }

    const ok = await canAccess({ roomId, role, userId }).catch(() => false);
    if (!ok) return ws.close(4003, 'Forbidden');

    ws.userType = role;
    ws.userId = userId;
    ws.roomId = roomId;
    _join(roomId, ws);
    _broadcast(roomId, { type: 'presence', data: _presenceSnapshot(roomId) });

    ws.on('message', (raw) => {
      // 客戶端不直接寫入 DB；訊息由 HTTP POST /api/chat/rooms/:id/messages 寫入後再廣播
      // 此處僅支援 ping/pong 等 keep-alive 訊號
      try {
        const m = JSON.parse(String(raw));
        if (m && m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      } catch { /* ignore */ }
    });

    ws.on('close', () => {
      _leave(roomId, ws);
      _broadcast(roomId, { type: 'presence', data: _presenceSnapshot(roomId) });
    });

    ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
  });

  // 30s 一次心跳，移除斷線
  setInterval(() => {
    for (const set of rooms.values()) {
      for (const c of set) {
        if (c.readyState !== WebSocket.OPEN) { _leave(c.roomId, c); continue; }
        try { c.ping(); } catch { /* ignore */ }
      }
    }
  }, 30000).unref();
}

function broadcastMessage(roomId, messageObj) {
  _broadcast(roomId, { type: 'message', data: messageObj });
}
function broadcastRead(roomId, payload) {
  _broadcast(roomId, { type: 'read', data: payload });
}

module.exports = { initWebSocket, broadcastMessage, broadcastRead };
