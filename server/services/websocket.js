/**
 * WebSocket 服務（聊天室即時通訊）
 * 每個聊天室對應一個 chat_room_id，連線時帶入驗證 token
 */
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const rooms = new Map(); // chat_room_id → Set<ws>

function initWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const roomId = url.searchParams.get('room');

    try {
      const user = jwt.verify(token, process.env.JWT_SECRET);
      ws.userId   = user.id;
      ws.userType = user.type; // 'parent' | 'coach'
      ws.roomId   = roomId;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);

      ws.on('message', (data) => {
        // 廣播給同房間其他成員
        const msg = JSON.parse(data);
        broadcast(roomId, { ...msg, senderId: user.id, senderType: user.type }, ws);
      });

      ws.on('close', () => {
        rooms.get(roomId)?.delete(ws);
      });
    } catch {
      ws.close(4001, 'Unauthorized');
    }
  });
}

function broadcast(roomId, data, exclude = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(data);
  room.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

module.exports = { initWebSocket, broadcast };
