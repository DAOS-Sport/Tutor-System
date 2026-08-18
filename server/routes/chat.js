/**
 * /api/chat — 聊天室 HTTP API（家長 + 教練共用，admin 走 /api/admin/chat）
 *
 *  GET   /rooms                          列出我的聊天室（依角色）
 *  GET   /rooms/:id                      取得房間 meta
 *  GET   /rooms/:id/messages?before=&limit=  分頁歷史訊息（新→舊）
 *  POST  /rooms/:id/messages             { content }                送文字
 *  POST  /rooms/:id/upload               multipart file → 自動寫入訊息（type=image|video|voice|file）
 *  POST  /rooms/:id/read                 { message_ids? }           標記已讀（未傳則整房未讀全標）
 */
const express = require('express');
const { singleUpload } = require('../middlewares/uploadError');
const multer = require('multer');
const { pool } = require('../models/db');
const { requireLiffUser } = require('../middlewares/parentAuth');
const chatRooms = require('../services/chatRooms');
const { saveBuffer, ALLOWED_MAX_BYTES } = require('../services/objectStorage');
const { scanAndAlert } = require('../services/keywordScanner');
const { broadcastMessage, broadcastRead } = require('../services/websocket');
const { notifyKeywordAlert } = require('./_chatNotify');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ALLOWED_MAX_BYTES } });

// multer 自己丟的錯（例如檔案過大）沒有 .status，不包的話會掉到全域
// 錯誤處理變成 500 + 英文訊息。實測 6MB 頭像回 500 "File too large"。
const uploadFile = singleUpload(upload, ALLOWED_MAX_BYTES);

async function authzRoom(req, res, next) {
  const ok = await chatRooms.canAccess({
    roomId: req.params.id,
    role: req.liffUser.type,
    userId: req.liffUser.id,
  });
  if (!ok) return res.status(403).json({ error: '無權限存取此聊天室' });
  next();
}

async function withSenderDisplayNames(roomId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];
  const coachIds = Array.from(new Set(rows.filter((m) => m.sender_type === 'coach' && m.sender_id).map((m) => m.sender_id)));
  const parentIds = Array.from(new Set(rows.filter((m) => m.sender_type === 'parent' && m.sender_id).map((m) => m.sender_id)));
  const coachMap = new Map();
  const parentMap = new Map();

  if (coachIds.length) {
    const r = await pool.query(
      `SELECT id, name FROM coaches WHERE id = ANY($1::uuid[])`,
      [coachIds]
    );
    for (const c of r.rows) coachMap.set(c.id, `${c.name} 教練`);
  }

  if (parentIds.length) {
    const r = await pool.query(
      `SELECT p.id, p.name,
              COALESCE(sn.student_names, '{}'::text[]) AS student_names
         FROM parents p
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT s.name)::text[] AS student_names
             FROM students s
             JOIN course_period_enrollments cpe
               ON cpe.student_id = s.id
              AND cpe.status = 'active'
             JOIN chat_rooms cr
               ON cr.course_period_id = cpe.course_period_id
            WHERE cr.id = $2
              AND s.parent_id = p.id
         ) sn ON TRUE
        WHERE p.id = ANY($1::uuid[])`,
      [parentIds, roomId]
    );
    for (const p of r.rows) {
      const names = Array.isArray(p.student_names) ? p.student_names.filter(Boolean) : [];
      parentMap.set(p.id, names.length ? `${p.name}（${names.join('、')}）` : p.name);
    }
  }

  return rows.map((m) => ({
    ...m,
    sender_display_name:
      m.sender_type === 'coach' ? (coachMap.get(m.sender_id) || '教練') :
      m.sender_type === 'parent' ? (parentMap.get(m.sender_id) || '家長') :
      '系統',
  }));
}

router.get('/rooms', requireLiffUser, async (req, res) => {
  try {
    const list = req.liffUser.type === 'parent'
      ? await chatRooms.listRoomsForParent(req.liffUser.id)
      : await chatRooms.listRoomsForCoach(req.liffUser.id);
    res.json(list);
  } catch (err) {
    console.error('[chat/rooms]', err);
    res.status(500).json({ error: 'list rooms failed' });
  }
});

router.get('/period/:coursePeriodId/room', requireLiffUser, async (req, res) => {
  try {
    const periodId = req.params.coursePeriodId;
    const pr = await pool.query(
      `SELECT id, coach_id, status FROM course_periods WHERE id = $1`,
      [periodId]
    );
    if (!pr.rowCount) return res.status(404).json({ error: '課程期不存在' });
    const period = pr.rows[0];

    let allowed = false;
    if (req.liffUser.type === 'coach') {
      allowed = period.coach_id === req.liffUser.id;
    } else if (req.liffUser.type === 'parent') {
      const own = await pool.query(
        `SELECT 1 FROM course_period_enrollments e
          JOIN students s ON s.id = e.student_id
         WHERE e.course_period_id = $1
           AND e.status = 'active'
           AND s.parent_id = $2`,
        [periodId, req.liffUser.id]
      );
      allowed = own.rowCount > 0;
    }
    if (!allowed) return res.status(403).json({ error: '無權限存取此課程聊天室' });
    if (period.status !== 'active') return res.status(409).json({ error: '課程尚未開通聊天室' });

    const room = await chatRooms.ensureRoomForPeriod(periodId);
    res.json({ room_id: room.id });
  } catch (err) {
    console.error('[chat/period/:coursePeriodId/room]', err);
    res.status(500).json({ error: 'get period room failed' });
  }
});

router.get('/rooms/:id', requireLiffUser, authzRoom, async (req, res) => {
  try {
    const meta = await chatRooms.getRoomMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not found' });
    res.json(meta);
  } catch (err) {
    console.error('[chat/rooms/:id]', err);
    res.status(500).json({ error: 'get room failed' });
  }
});

router.get('/rooms/:id/messages', requireLiffUser, authzRoom, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before;
    const args = [req.params.id];
    let where = `chat_room_id = $1`;
    if (before) { args.push(before); where += ` AND created_at < $${args.length}`; }
    args.push(limit);
    const r = await pool.query(
      `SELECT id, chat_room_id, sender_type, sender_id, message_type, content, media_url,
              media_filename, media_size_bytes, created_at
         FROM messages
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${args.length}`,
      args
    );
    // 已讀狀態：
    //   read_by_me   = viewer 已讀此訊息（控制收訊端未讀指示）
    //   read_by_peer = 對手方已讀此訊息（控制 viewer 自己發出去的「已讀」）
    const ids = r.rows.map((m) => m.id);
    const myReads = new Set();
    const peerReads = new Set();
    if (ids.length) {
      const rd = await pool.query(
        `SELECT message_id, reader_type, reader_id FROM message_reads
          WHERE message_id = ANY($1)`,
        [ids]
      );
      const myType = req.liffUser.type, myId = req.liffUser.id;
      for (const x of rd.rows) {
        if (x.reader_type === myType && x.reader_id === myId) myReads.add(x.message_id);
        else peerReads.add(x.message_id);
      }
    }
    const rows = await withSenderDisplayNames(req.params.id, r.rows);
    res.json(rows.reverse().map((m) => ({
      ...m,
      read_by_me: myReads.has(m.id),
      read_by_peer: peerReads.has(m.id),
    })));
  } catch (err) {
    console.error('[chat messages]', err);
    res.status(500).json({ error: 'list messages failed' });
  }
});

async function _persistAndBroadcast({ roomId, sender, type, content, media }) {
  const r = await pool.query(
    `INSERT INTO messages (chat_room_id, sender_type, sender_id, message_type, content,
                           media_url, media_filename, media_size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, chat_room_id, sender_type, sender_id, message_type, content,
               media_url, media_filename, media_size_bytes, created_at`,
    [roomId, sender.type, sender.id, type, content || null,
     media?.url || null, media?.filename || null, media?.size || null]
  );
  const [msg] = await withSenderDisplayNames(roomId, r.rows);
  broadcastMessage(roomId, msg);
  // 關鍵字掃描：所有「有 content 字串」的訊息都掃，包含 image/file 附件 caption（spec F-A07）
  if (content) {
    const alerts = await scanAndAlert({ messageId: msg.id, chatRoomId: roomId, content });
    if (alerts.length) notifyKeywordAlert({ roomId, message: msg, alerts }).catch((e) =>
      console.warn('[chat] notifyKeywordAlert failed:', e.message)
    );
  }
  return msg;
}

router.post('/rooms/:id/messages', requireLiffUser, authzRoom, async (req, res) => {
  try {
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: '訊息內容必填' });
    if (content.length > 2000) return res.status(400).json({ error: '訊息過長（上限 2000 字）' });
    const msg = await _persistAndBroadcast({
      roomId: req.params.id,
      sender: req.liffUser,
      type: 'text',
      content,
    });
    res.status(201).json(msg);
  } catch (err) {
    console.error('[chat send]', err);
    res.status(500).json({ error: 'send failed' });
  }
});

router.post('/rooms/:id/upload', requireLiffUser, authzRoom, uploadFile, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
    const saved = await saveBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    const msg = await _persistAndBroadcast({
      roomId: req.params.id,
      sender: req.liffUser,
      type: saved.messageType,
      content: req.body?.caption || null,
      media: saved,
    });
    res.status(201).json(msg);
  } catch (err) {
    console.error('[chat upload]', err);
    res.status(400).json({ error: err.message || 'upload failed' });
  }
});

router.post('/rooms/:id/read', requireLiffUser, authzRoom, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.message_ids) ? req.body.message_ids : null;
    let toMark;
    if (ids && ids.length) {
      toMark = await pool.query(
        `SELECT id FROM messages
          WHERE id = ANY($1) AND chat_room_id = $2
            AND NOT (sender_type = $3 AND sender_id = $4)`,
        [ids, req.params.id, req.liffUser.type, req.liffUser.id]
      );
    } else {
      toMark = await pool.query(
        `SELECT id FROM messages
          WHERE chat_room_id = $1 AND NOT (sender_type = $2 AND sender_id = $3)
            AND NOT EXISTS (SELECT 1 FROM message_reads r
                             WHERE r.message_id = messages.id
                               AND r.reader_type = $2 AND r.reader_id = $3)`,
        [req.params.id, req.liffUser.type, req.liffUser.id]
      );
    }
    const messageIds = toMark.rows.map((x) => x.id);
    for (const mid of messageIds) {
      await pool.query(
        `INSERT INTO message_reads (message_id, reader_type, reader_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [mid, req.liffUser.type, req.liffUser.id]
      );
    }
    if (messageIds.length) {
      broadcastRead(req.params.id, {
        reader_type: req.liffUser.type, reader_id: req.liffUser.id, message_ids: messageIds,
      });
    }
    res.json({ ok: true, marked: messageIds.length });
  } catch (err) {
    console.error('[chat read]', err);
    res.status(500).json({ error: 'mark read failed' });
  }
});

module.exports = router;
