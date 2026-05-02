/**
 * 場館營運：今日課程 / 簽到驗證 / 退課時段復活 (F-R01 / F-R03 / F-M05)
 *  GET   /api/admin/sessions/today           ?venueId=
 *  GET   /api/admin/sessions/verify-checkin  ?phone= &periodId=
 *  GET   /api/admin/sessions/cancelled
 *  POST  /api/admin/sessions/:id/revive      （主管權限）
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();

function rowToSession(r) {
  return {
    id: r.id,
    date: typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().slice(0, 10),
    start: r.start_time,
    end: r.end_time,
    venue_id: r.venue_id,
    coach: r.coach,
    students: r.students || [],
    course_type: r.course_type,
    checkin_status: r.checkin_status,
  };
}

function rowToCancelled(r) {
  return {
    id: r.id,
    date: typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().slice(0, 10),
    start: r.start_time,
    period_id: r.period_id,
    parent_name: r.parent_name,
    coach: r.coach,
    venue_id: r.venue_id,
    refunded: !!r.refunded,
  };
}

router.get('/today', requireAdminAuth, async (req, res) => {
  try {
    // staff 強制只看自己的場館；admin / manager 可帶 venueId 跨館篩選
    const venueId = req.adminUser.role === 'staff'
      ? (req.adminUser.venue_id || '__no_venue__')
      : req.query.venueId;
    const sql = venueId
      ? `SELECT * FROM admin_today_sessions WHERE venue_id = $1 ORDER BY start_time`
      : `SELECT * FROM admin_today_sessions ORDER BY start_time`;
    const r = venueId ? await pool.query(sql, [venueId]) : await pool.query(sql);
    res.json(r.rows.map(rowToSession));
  } catch (err) {
    console.error('[admin/sessions/today]', err);
    res.status(500).json({ error: 'load today sessions failed' });
  }
});

router.get('/verify-checkin', requireAdminAuth, async (req, res) => {
  try {
    const { phone, periodId } = req.query;
    if (!phone && !periodId) return res.json({ found: false });

    const where = [];
    const args = [];
    if (periodId) { args.push(periodId); where.push(`id = $${args.length}`); }
    if (phone) { args.push(phone); where.push(`parent_phone = $${args.length}`); }
    // staff 角色：限定本場館；查到別館一律回 found:false（避免推測其他場館報名是否存在）
    if (req.adminUser.role === 'staff') {
      args.push(req.adminUser.venue_id || '__no_venue__');
      where.push(`venue_id = $${args.length}`);
    }
    const r = await pool.query(
      `SELECT * FROM admin_enrollments WHERE ${where.join(' AND ')} ORDER BY submitted_at DESC LIMIT 1`,
      args
    );
    if (!r.rowCount) return res.json({ found: false });
    const e = r.rows[0];

    const enrollment = {
      id: e.id,
      parent_name: e.parent_name,
      parent_phone: e.parent_phone,
      students: e.students || [],
      coach: e.coach,
      venue_id: e.venue_id,
      course_type: e.course_type,
      original_price: Number(e.original_price),
      final_price: Number(e.final_price),
      transfer_last_5: e.transfer_last_5,
      status: e.status,
      submitted_at: typeof e.submitted_at === 'string' ? e.submitted_at : new Date(e.submitted_at).toISOString().slice(0, 19),
      total_sessions: e.total_sessions,
      used_sessions: e.used_sessions,
    };

    const s = await pool.query(
      `SELECT * FROM admin_today_sessions WHERE coach = $1 AND venue_id = $2 LIMIT 1`,
      [e.coach, e.venue_id]
    );
    res.json({
      found: true,
      enrollment,
      session: s.rowCount ? rowToSession(s.rows[0]) : null,
    });
  } catch (err) {
    console.error('[admin/sessions/verify-checkin]', err);
    res.status(500).json({ error: 'verify checkin failed' });
  }
});

router.get('/cancelled', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM admin_cancelled_sessions ORDER BY date DESC, start_time`);
    res.json(r.rows.map(rowToCancelled));
  } catch (err) {
    console.error('[admin/sessions/cancelled]', err);
    res.status(500).json({ error: 'load cancelled failed' });
  }
});

router.post('/:id/revive', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const cur = await client.query(`SELECT * FROM admin_cancelled_sessions WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'cancelled session not found' });
    }
    await client.query(`UPDATE admin_cancelled_sessions SET refunded = TRUE WHERE id = $1`, [id]);

    // 將堂數歸還給對應的 enrollment（used_sessions - 1，下限 0）
    const periodId = cur.rows[0].period_id;
    if (periodId) {
      await client.query(
        `UPDATE admin_enrollments
            SET used_sessions = GREATEST(COALESCE(used_sessions, 0) - 1, 0),
                updated_at = NOW()
          WHERE id = $1 AND used_sessions IS NOT NULL AND used_sessions > 0`,
        [periodId]
      );
      const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
         VALUES ($1, $2, $3)`,
        [periodId, `退課時段復活（${id}，已歸還 1 堂）`, by]
      );
    }
    await client.query('COMMIT');
    const r = await pool.query(`SELECT * FROM admin_cancelled_sessions WHERE id = $1`, [id]);
    res.json(rowToCancelled(r.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/sessions/:id/revive]', err);
    res.status(500).json({ error: 'revive failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
