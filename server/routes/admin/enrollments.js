/**
 * 報名 / 對帳 / 退費 (F-M02 / F-R02 / F-R04)
 *  GET    /api/admin/enrollments                    ?status= &search= &venueId=
 *  POST   /api/admin/enrollments/:id/reconcile      對帳通過
 *  GET    /api/admin/enrollments/:id/refund-preview 退費預覽
 *  POST   /api/admin/enrollments/:id/refund         退課退費
 *
 * mock.js enrollments() 回傳每筆：
 *   { id, parent_name, parent_phone, students[], coach, venue_id, course_type,
 *     original_price, final_price, transfer_last_5, status, submitted_at,
 *     total_sessions, used_sessions, audit_logs[] }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();

async function getSettings() {
  const r = await pool.query(`SELECT key, value FROM admin_settings`);
  const out = {};
  for (const row of r.rows) out[row.key] = Number(row.value);
  return out;
}

function tsToString(d) {
  if (!d) return null;
  if (typeof d === 'string') return d;
  // 取「YYYY-MM-DDTHH:mm:ss」格式（不含 ms / timezone），與 mock 行為對齊
  const iso = new Date(d).toISOString();
  return iso.slice(0, 19);
}

async function readEnrollment(id) {
  const e = await pool.query(`SELECT * FROM admin_enrollments WHERE id = $1`, [id]);
  if (!e.rowCount) return null;
  const a = await pool.query(
    `SELECT at, action, by_user, reason, refund_amount FROM admin_enrollment_audit_logs
     WHERE enrollment_id = $1 ORDER BY at ASC, id ASC`,
    [id]
  );
  const row = e.rows[0];
  return {
    id: row.id,
    parent_name: row.parent_name,
    parent_phone: row.parent_phone,
    students: row.students || [],
    coach: row.coach,
    venue_id: row.venue_id,
    course_type: row.course_type,
    original_price: Number(row.original_price),
    final_price: Number(row.final_price),
    transfer_last_5: row.transfer_last_5,
    status: row.status,
    submitted_at: tsToString(row.submitted_at),
    total_sessions: row.total_sessions,
    used_sessions: row.used_sessions,
    refund_amount: row.refund_amount != null ? Number(row.refund_amount) : undefined,
    audit_logs: a.rows.map((x) => ({
      at: tsToString(x.at),
      action: x.action,
      by: x.by_user,
      ...(x.reason ? { reason: x.reason } : {}),
      ...(x.refund_amount != null ? { refund_amount: Number(x.refund_amount) } : {}),
    })),
  };
}

router.get('/', requireAdminAuth, async (req, res) => {
  try {
    const { status, search } = req.query;
    // 場館範圍：staff 角色強制鎖在自己的 venue（忽略 client 端傳來的 venueId）；
    // admin / manager 才能用 venueId query 跨館篩選。
    const venueId = req.adminUser.role === 'staff'
      ? (req.adminUser.venue_id || '__no_venue__')
      : req.query.venueId;
    const where = [];
    const args = [];
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    if (venueId) { args.push(venueId); where.push(`venue_id = $${args.length}`); }
    if (search) {
      args.push(`%${search.toLowerCase()}%`);
      const idx = args.length;
      where.push(`(
        LOWER(parent_name) LIKE $${idx} OR
        parent_phone LIKE $${idx} OR
        LOWER(coach) LIKE $${idx} OR
        LOWER(id) LIKE $${idx} OR
        EXISTS (SELECT 1 FROM unnest(students) s WHERE LOWER(s) LIKE $${idx})
      )`);
    }
    const sql = `SELECT id FROM admin_enrollments
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY submitted_at DESC`;
    const r = await pool.query(sql, args);
    const out = [];
    for (const row of r.rows) out.push(await readEnrollment(row.id));
    res.json(out);
  } catch (err) {
    console.error('[admin/enrollments]', err);
    res.status(500).json({ error: 'list enrollments failed' });
  }
});

router.post('/:id/reconcile', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const by = (req.body && req.body.by) || req.adminUser?.name || req.adminUser?.username || 'unknown';

    const cur = await client.query(`SELECT * FROM admin_enrollments WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'enrollment not found' });
    }
    if (cur.rows[0].status !== 'pending_payment') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '此筆狀態非待對帳' });
    }

    const settings = await getSettings();
    const total = settings.sessions_per_period || 6;

    await client.query(
      `UPDATE admin_enrollments
         SET status = 'confirmed',
             total_sessions = $2,
             used_sessions = 0,
             updated_at = NOW()
       WHERE id = $1`,
      [id, total]
    );
    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
       VALUES ($1, $2, $3)`,
      [id, '對帳通過', by]
    );

    await client.query('COMMIT');
    res.json(await readEnrollment(id));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/enrollments/:id/reconcile]', err);
    res.status(500).json({ error: 'reconcile failed' });
  } finally {
    client.release();
  }
});

async function computeRefundPreview(id) {
  const enrollment = await readEnrollment(id);
  if (!enrollment) return null;
  const settings = await getSettings();
  const total = enrollment.total_sessions || settings.sessions_per_period || 6;
  const used = enrollment.used_sessions || 0;
  const remainRatio = Math.max(0, (total - used) / total);
  const fee_rate = settings.refund_fee_rate ?? 0.1;
  const refund_amount = Math.round(enrollment.final_price * remainRatio * (1 - fee_rate));
  return { enrollment, total, used, remainRatio, fee_rate, refund_amount };
}

router.get('/:id/refund-preview', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const preview = await computeRefundPreview(req.params.id);
    if (!preview) return res.status(404).json({ error: 'enrollment not found' });
    res.json(preview);
  } catch (err) {
    console.error('[admin/enrollments/:id/refund-preview]', err);
    res.status(500).json({ error: 'preview failed' });
  }
});

router.post('/:id/refund', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const reason = (req.body && req.body.reason || '').trim();
    if (!reason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '退課理由必填' });
    }
    const by = (req.body && req.body.by) || req.adminUser?.name || req.adminUser?.username || 'unknown';

    const preview = await computeRefundPreview(id);
    if (!preview) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'enrollment not found' });
    }

    await client.query(
      `UPDATE admin_enrollments SET status = 'refunded', refund_amount = $2, updated_at = NOW() WHERE id = $1`,
      [id, preview.refund_amount]
    );
    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason, refund_amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, `退課（理由：${reason}，退款 NT$ ${preview.refund_amount.toLocaleString()}）`, by, reason, preview.refund_amount]
    );
    await client.query('COMMIT');

    const updated = await readEnrollment(id);
    res.json({ ...updated, refund_amount: preview.refund_amount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/enrollments/:id/refund]', err);
    res.status(500).json({ error: 'refund failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
