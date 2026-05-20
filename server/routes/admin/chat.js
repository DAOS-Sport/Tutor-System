/**
 * /api/admin/chat — 後台聊天監察 (F-M03) + 關鍵字管理 (F-A07) + 警示清單
 *
 *  GET    /rooms                          ?venueId= &search=    所有聊天室列表
 *  GET    /rooms/:id/messages             房間訊息（唯讀，最新 200 筆）
 *
 *  GET    /keywords                       關鍵字清單
 *  POST   /keywords      { keyword, category }
 *  PATCH  /keywords/:id  { keyword?, category?, is_active? }
 *  DELETE /keywords/:id
 *
 *  GET    /alerts                         ?status=pending|reviewed|resolved
 *  PATCH  /alerts/:id    { status, review_note? }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole, getScopedVenueIds } = require('../../middlewares/adminAuth');
const chatRooms = require('../../services/chatRooms');
const { invalidateCache } = require('../../services/keywordScanner');

const router = express.Router();

// ── 聊天室監察 ─────────────────────────────
// 場館邊界 (broken-access-control 防護)：
//   admin   → 可看全部，可用 ?venueId= / ?venueIds= 過濾
//   manager → 只能看自己所屬場館清單；忽略不在清單內的 query.venueId
//   staff   → 同 manager
//   無 venue_ids 的 manager/staff → fail closed（'__no_venue__' 不會匹配）
function scopedVenueIdsForChat(req) {
  const scope = getScopedVenueIds(req);
  if (!scope) {
    // admin
    if (req.query.venueId) return [String(req.query.venueId)];
    return null;
  }
  if (req.query.venueId && scope.includes(String(req.query.venueId))) {
    return [String(req.query.venueId)];
  }
  return scope;
}

router.get('/rooms', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const list = await chatRooms.listRoomsForAdmin({
      venueIds: scopedVenueIdsForChat(req),
      search: req.query.search,
    });
    res.json(list);
  } catch (err) {
    console.error('[admin/chat/rooms]', err);
    res.status(500).json({ error: 'list rooms failed' });
  }
});

router.get('/rooms/:id/messages', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const meta = await chatRooms.getRoomMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not found' });
    // Task #90：manager 只能看自己所屬場館清單內的聊天室
    const scope = getScopedVenueIds(req);
    if (scope && !scope.includes(meta.venue?.id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const r = await pool.query(
      `SELECT id, sender_type, sender_id, message_type, content, media_url, media_filename,
              media_size_bytes, created_at
         FROM messages
        WHERE chat_room_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.params.id, limit]
    );
    res.json({ room: meta, messages: r.rows.reverse() });
  } catch (err) {
    console.error('[admin/chat/rooms/:id/messages]', err);
    res.status(500).json({ error: 'list messages failed' });
  }
});

// ── 關鍵字管理 (F-A07，admin only) ─────────
router.get('/keywords', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, keyword, category, is_active, created_at
         FROM keyword_list ORDER BY is_active DESC, category, keyword`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/chat/keywords]', err);
    res.status(500).json({ error: 'list keywords failed' });
  }
});

router.post('/keywords', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const keyword = String(req.body?.keyword || '').trim();
    const category = String(req.body?.category || '其他').trim() || '其他';
    if (!keyword) return res.status(400).json({ error: '關鍵字必填' });
    if (keyword.length > 100) return res.status(400).json({ error: '關鍵字過長' });
    const r = await pool.query(
      `INSERT INTO keyword_list (keyword, category, is_active) VALUES ($1, $2, TRUE)
       ON CONFLICT (keyword) DO UPDATE SET category = EXCLUDED.category, is_active = TRUE
       RETURNING id, keyword, category, is_active, created_at`,
      [keyword, category]
    );
    invalidateCache();
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[admin/chat/keywords POST]', err);
    res.status(500).json({ error: 'create failed' });
  }
});

router.patch('/keywords/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const fields = [];
    const args = [];
    if (typeof req.body.keyword === 'string') {
      const v = req.body.keyword.trim();
      if (!v) return res.status(400).json({ error: '關鍵字不可空白' });
      args.push(v); fields.push(`keyword = $${args.length}`);
    }
    if (typeof req.body.category === 'string') {
      args.push(req.body.category.trim() || '其他'); fields.push(`category = $${args.length}`);
    }
    if (typeof req.body.is_active === 'boolean') {
      args.push(req.body.is_active); fields.push(`is_active = $${args.length}`);
    }
    if (!fields.length) return res.status(400).json({ error: '無變更欄位' });
    args.push(req.params.id);
    const r = await pool.query(
      `UPDATE keyword_list SET ${fields.join(', ')} WHERE id = $${args.length}
       RETURNING id, keyword, category, is_active, created_at`,
      args
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    invalidateCache();
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[admin/chat/keywords PATCH]', err);
    res.status(500).json({ error: 'update failed' });
  }
});

router.delete('/keywords/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM keyword_list WHERE id = $1`, [req.params.id]);
    invalidateCache();
    res.json({ ok: r.rowCount > 0 });
  } catch (err) {
    console.error('[admin/chat/keywords DELETE]', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

// ── 警示清單（僅 admin / manager 可見；staff 不應看到關鍵字命中） ──
router.get('/alerts', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const status = req.query.status;
    const args = [];
    const wh = [];
    if (status) { args.push(status); wh.push(`a.status = $${args.length}`); }
    // Task #90：manager 限定自己所屬全部場館；無 venue_ids 即 fail closed
    const scope = getScopedVenueIds(req);
    if (scope) {
      args.push(scope);
      wh.push(`cp.venue_id = ANY($${args.length}::text[])`);
    }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const r = await pool.query(`
      SELECT a.id, a.chat_room_id, a.message_id, a.triggered_keyword, a.status,
             a.review_note, a.created_at, a.reviewed_at,
             m.content       AS message_content,
             m.sender_type   AS sender_type,
             m.created_at    AS message_at,
             cp.id           AS course_period_id,
             co.name         AS coach_name,
             v.name          AS venue_name
        FROM keyword_alerts a
        JOIN messages m       ON m.id = a.message_id
        JOIN chat_rooms cr    ON cr.id = a.chat_room_id
        JOIN course_periods cp ON cp.id = cr.course_period_id
        JOIN coaches co       ON co.id = cp.coach_id
        JOIN venues v         ON v.id  = cp.venue_id
        ${where}
        ORDER BY a.created_at DESC
        LIMIT 300
    `, args);
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/chat/alerts]', err);
    res.status(500).json({ error: 'list alerts failed' });
  }
});

router.patch('/alerts/:id', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const status = String(req.body?.status || '').trim();
    if (!['pending', 'reviewed', 'no_issue', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    // Task #90：manager 只能改自己所屬場館清單內的警示；無 venue_ids fail closed
    const scope = getScopedVenueIds(req);
    if (scope) {
      const own = await pool.query(`
        SELECT cp.venue_id FROM keyword_alerts a
          JOIN chat_rooms cr     ON cr.id = a.chat_room_id
          JOIN course_periods cp ON cp.id = cr.course_period_id
         WHERE a.id = $1`, [req.params.id]);
      if (!own.rowCount) return res.status(404).json({ error: 'not found' });
      if (!scope.includes(own.rows[0].venue_id)) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }
    // review_note 語意：
    //   undefined → 不動現有值（COALESCE 路徑）
    //   string    → 覆寫（含空字串 '' → 視為清空，存 null 方便 UI 一致呈現「—」）
    const hasNote = Object.prototype.hasOwnProperty.call(req.body || {}, 'review_note');
    let note = null;
    if (hasNote) {
      const raw = req.body.review_note;
      note = raw == null ? null : String(raw).slice(0, 500).trim() || null;
    }
    // 審核稽核：reviewed_by 帶 admin/manager 自己的 id（admin JWT.sub）
    const reviewerId = req.adminUser?.sub || req.adminUser?.id || null;
    const r = await pool.query(
      `UPDATE keyword_alerts
          SET status = $1::alert_status,
              review_note = CASE WHEN $4::boolean THEN $2 ELSE COALESCE($2, review_note) END,
              reviewed_at = NOW(),
              reviewed_by = $5
        WHERE id = $3
        RETURNING id, status, review_note, reviewed_at, reviewed_by`,
      [status, note, req.params.id, hasNote, reviewerId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[admin/chat/alerts PATCH]', err);
    res.status(500).json({ error: 'update failed' });
  }
});

module.exports = router;
