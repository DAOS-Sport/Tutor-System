/**
 * WebSocket 服務（聊天室即時推播）
 *
 * 連線：ws(s)://host/ws?token=<JWT>&room=<chat_room_id>
 *  - JWT 驗證：parent / coach / admin / manager token（共用 JWT_SECRET）
 *      · staff token 雖可 verify，但 chatRooms.canAccess('staff') 一律回 false →
 *        會在 connection handler 內 close(4003)；F-M03 政策：staff 不得查閱聊天內容。
 *        參考 docs/adr_phase4_chat.md §4。
 *  - room 授權：透過 chatRooms.canAccess 嚴格檢查
 *      · parent / coach：必須是該 period 的參與者
 *      · admin：全域；manager：限自己 venue（WS 端從 admin JWT.venue_id 取得）
 *      · WS 只接收訊息/已讀/上線廣播，不寫入（寫入走 HTTP POST /api/chat/rooms/:id/messages）
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
// Task #60：後台事件總線（簽到等即時推播給所有已登入後台 client）
const adminClients = new Set();

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
  // 兩個 path 共用同一個 http server → 用 noServer + 手動 upgrade 路由（避免雙重 upgrade listener 衝突）
  const wss = new WebSocket.Server({ noServer: true });
  // Task #60：後台事件總線（簽到 list 即時推播）。獨立 path 避開既有 chat-room 授權邏輯。
  const wssAdmin = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (pathname === '/ws/admin') {
      wssAdmin.handleUpgrade(req, socket, head, (ws) => wssAdmin.emit('connection', ws, req));
    } else if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });
  wssAdmin.on('connection', (ws, req) => {
    let payload;
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) return ws.close(4400, 'Missing token');
      payload = jwt.verify(token, getSecret());
      if (!payload?.role || !['admin','manager','staff'].includes(payload.role)) {
        return ws.close(4003, 'Unsupported token');
      }
    } catch {
      return ws.close(4001, 'Invalid token');
    }
    ws.adminRole = payload.role;
    // Task #90：支援多場館員工 — 收 venue_ids 陣列；舊 token 退回 [venue_id]
    ws.adminVenueIds = Array.isArray(payload.venue_ids) && payload.venue_ids.length
      ? payload.venue_ids
      : (payload.venue_id ? [payload.venue_id] : []);
    ws.adminVenueId = ws.adminVenueIds[0] || null;
    adminClients.add(ws);
    ws.on('close', () => adminClients.delete(ws));
    ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
    ws.on('message', (raw) => {
      try { const m = JSON.parse(String(raw)); if (m?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch { /* ignore */ }
    });
  });

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

    let role, userId, venueId = null;
    if (payload.type === 'parent') { role = 'parent'; userId = payload.parentId; }
    else if (payload.type === 'coach') { role = 'coach'; userId = payload.coachId; }
    else if (payload.role && ['admin', 'manager', 'staff'].includes(payload.role)) {
      // admin token 走 routes/admin/auth.js 簽發，payload.role/venue_id 帶角色與場館
      role = payload.role;
      userId = payload.sub || null;
      venueId = payload.venue_id || null;
    } else {
      return ws.close(4003, 'Unsupported token type');
    }

    const ok = await canAccess({ roomId, role, userId, venueId }).catch(() => false);
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

// Task #60：對所有後台 WS client 廣播事件；可帶 venueId 做 server 端過濾
// （staff 與 manager 只收到自己場館；admin 全收）
function broadcastAdminEvent(eventType, payload) {
  const data = JSON.stringify({ type: eventType, data: payload });
  for (const c of adminClients) {
    if (c.readyState !== WebSocket.OPEN) { adminClients.delete(c); continue; }
    // 嚴格 least-privilege：admin 全收；非 admin 必須有 venue_id 且與 payload.venue_id 相符；
    // 任一邊缺 venue_id 一律 drop（避免 staff/manager 帳號設定異常時看到跨場館資料）
    if (c.adminRole !== 'admin') {
      // Task #90：event venue_id 須在 client 所屬 venue_ids 內；任一邊缺值一律 drop
      const ids = c.adminVenueIds && c.adminVenueIds.length ? c.adminVenueIds : (c.adminVenueId ? [c.adminVenueId] : []);
      if (!payload?.venue_id || !ids.length || !ids.includes(payload.venue_id)) continue;
    }
    try { c.send(data); } catch { /* ignore */ }
  }
}

module.exports = { initWebSocket, broadcastMessage, broadcastRead, broadcastAdminEvent };
