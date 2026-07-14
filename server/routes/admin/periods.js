/**
 * /api/admin/periods — course_periods 狀態維運（spec F-S09 對齊）
 *
 * 此處的 POST /:id/activate 是「狀態 → active」的 canonical 路由切口：
 * 走 chatRooms.transitionPeriodToActive() 同時翻牌 + 冪等建立 chat_room，
 * 避免依賴 cron backfill 才補建房間。任何後續會走「期數轉 active」的
 * UI/服務都應改打這個端點，而不是直接 UPDATE course_periods.status。
 *
 * 權限：admin / manager（manager 必須是該 period 所屬場館）。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole, getScopedVenueIds } = require('../../middlewares/adminAuth');
const chatRooms = require('../../services/chatRooms');

const router = express.Router();

const CHECKIN_MODES = ['booking', 'self'];
const MODE_LABEL = { booking: '預約制', self: '自助簽到' };

/**
 * U13 雙軌簽到 — 簽到模式管理清單。
 *  GET /api/admin/periods/checkin-modes?venueId=&mode=&search=
 *  進行中（active）課程期逐列：場館/教練/學員/組別/期別/堂數使用/模式。
 *  staff 可檢視（場館範圍內）；切換僅 admin/manager（見 PATCH/bulk）。
 */
router.get('/checkin-modes', requireAdminAuth, async (req, res) => {
  try {
    const where = [`cp.status = 'active'`];
    const args = [];
    const scope = getScopedVenueIds(req);
    if (scope) {
      args.push(scope);
      where.push(`cp.venue_id = ANY($${args.length}::text[])`);
      if (req.query.venueId && scope.includes(String(req.query.venueId))) {
        args.push(String(req.query.venueId));
        where.push(`cp.venue_id = $${args.length}`);
      }
    } else if (req.query.venueId) {
      args.push(String(req.query.venueId));
      where.push(`cp.venue_id = $${args.length}`);
    }
    if (req.query.mode && CHECKIN_MODES.includes(String(req.query.mode))) {
      args.push(String(req.query.mode));
      where.push(`cp.checkin_mode = $${args.length}`);
    }
    if (req.query.search) {
      args.push(`%${String(req.query.search).toLowerCase()}%`);
      const idx = args.length;
      where.push(`(
        LOWER(COALESCE(c.name, '')) LIKE $${idx} OR
        EXISTS (SELECT 1 FROM course_period_enrollments cpe2
                  JOIN students s2 ON s2.id = cpe2.student_id
                 WHERE cpe2.course_period_id = cp.id AND LOWER(s2.name) LIKE $${idx})
      )`);
    }
    const r = await pool.query(
      `SELECT cp.id, cp.venue_id, COALESCE(av.name, cp.venue_id) AS venue_name,
              cp.course_type, cp.period_number, cp.total_sessions, cp.expires_at,
              cp.checkin_mode, c.name AS coach_name,
              COALESCE((SELECT json_agg(s.name ORDER BY s.name)
                          FROM course_period_enrollments cpe
                          JOIN students s ON s.id = cpe.student_id
                         WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'), '[]'::json) AS students,
              COALESCE((SELECT COUNT(DISTINCT cr.course_session_id)::int
                          FROM checkin_records cr
                          JOIN course_sessions cs ON cs.id = cr.course_session_id
                         WHERE cs.course_period_id = cp.id), 0) AS used_sessions,
              EXISTS (SELECT 1 FROM course_sessions cs2
                       WHERE cs2.course_period_id = cp.id
                         AND cs2.created_via = 'self_checkin'
                         AND cs2.self_checkin_date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
                         AND cs2.status NOT IN ('cancelled_normal','cancelled_penalty')) AS self_checked_in_today
         FROM course_periods cp
         LEFT JOIN coaches c ON c.id = cp.coach_id
         LEFT JOIN admin_venues av ON av.id = cp.venue_id
        WHERE ${where.join(' AND ')}
        ORDER BY av.name NULLS LAST, c.name NULLS LAST, cp.created_at DESC`,
      args
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/periods/checkin-modes]', err);
    res.status(500).json({ error: 'load checkin modes failed' });
  }
});

/**
 * 單期切換簽到模式。audit 掛在 period 的 anchor 報名單（admin_enrollment_id）上，
 * 讓「誰在何時把哪期切成什麼模式」在報名審計紀錄可查。
 *  PATCH /api/admin/periods/:id/checkin-mode  { mode: 'booking' | 'self' }
 */
router.patch('/:id/checkin-mode', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  const mode = String(req.body?.mode || '').trim();
  if (!CHECKIN_MODES.includes(mode)) {
    return res.status(400).json({ error: 'mode 必須為 booking 或 self', code: 'MODE_INVALID' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT id, venue_id, checkin_mode, admin_enrollment_id FROM course_periods WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'period not found' });
    }
    const scope = getScopedVenueIds(req);
    if (scope && !scope.includes(cur.rows[0].venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此課程期不在您的場館範圍內' });
    }
    const before = cur.rows[0].checkin_mode || 'booking';
    if (before !== mode) {
      await client.query(
        `UPDATE course_periods SET checkin_mode = $2, updated_at = NOW() WHERE id = $1`,
        [req.params.id, mode]
      );
      if (cur.rows[0].admin_enrollment_id) {
        const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
        await client.query(
          `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
           SELECT id, $2, $3 FROM admin_enrollments WHERE id = $1`,
          [cur.rows[0].admin_enrollment_id,
           `切換簽到模式：${MODE_LABEL[before]} → ${MODE_LABEL[mode]}（期 ${req.params.id}）`, by]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ id: req.params.id, checkin_mode: mode, changed: before !== mode });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/periods/:id/checkin-mode]', err);
    res.status(500).json({ error: 'switch mode failed' });
  } finally {
    client.release();
  }
});

/**
 * 整館批次切換（進行中期別全切）。回傳實際變更筆數；逐期 audit 同單期切換。
 *  POST /api/admin/periods/checkin-mode/bulk  { venue_id, mode }
 */
router.post('/checkin-mode/bulk', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  const venueId = String(req.body?.venue_id || '').trim();
  const mode = String(req.body?.mode || '').trim();
  if (!venueId) return res.status(400).json({ error: '請指定場館', code: 'VENUE_REQUIRED' });
  if (!CHECKIN_MODES.includes(mode)) {
    return res.status(400).json({ error: 'mode 必須為 booking 或 self', code: 'MODE_INVALID' });
  }
  const scope = getScopedVenueIds(req);
  if (scope && !scope.includes(venueId)) {
    return res.status(403).json({ error: '此場館不在您的範圍內' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE course_periods
          SET checkin_mode = $2, updated_at = NOW()
        WHERE venue_id = $1 AND status = 'active' AND checkin_mode <> $2
        RETURNING id, admin_enrollment_id`,
      [venueId, mode]
    );
    const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
    const anchorIds = upd.rows.map((row) => row.admin_enrollment_id).filter(Boolean);
    if (anchorIds.length) {
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
         SELECT id, $2, $3 FROM admin_enrollments WHERE id = ANY($1::text[])`,
        [anchorIds, `整館批次切換簽到模式 → ${MODE_LABEL[mode]}（${venueId}）`, by]
      );
    }
    await client.query('COMMIT');
    res.json({ venue_id: venueId, checkin_mode: mode, changed: upd.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/periods/checkin-mode/bulk]', err);
    res.status(500).json({ error: 'bulk switch failed' });
  } finally {
    client.release();
  }
});

router.post('/:id/activate', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const owns = await pool.query(
      `SELECT id, venue_id, status FROM course_periods WHERE id = $1`, [req.params.id]
    );
    if (!owns.rowCount) return res.status(404).json({ error: 'period not found' });
    // Task #90：manager 須在自己所屬場館清單內
    const scope = getScopedVenueIds(req);
    if (scope && !scope.includes(owns.rows[0].venue_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const out = await chatRooms.transitionPeriodToActive(req.params.id);
    res.json({ period_id: req.params.id, activated: out.activated, room: out.room });
  } catch (err) {
    console.error('[admin/periods/activate]', err);
    res.status(500).json({ error: 'activate failed' });
  }
});

module.exports = router;
