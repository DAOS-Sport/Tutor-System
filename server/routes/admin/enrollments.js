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
    invoice_number: row.invoice_number || null,
    invoice_image_url: row.invoice_image_url || null,
    invoice_url: row.invoice_url || null,
    invoice_issued_at: tsToString(row.invoice_issued_at),
    extra_parent_phones: row.extra_parent_phones || [],
    notes: row.notes || null,
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

/**
 * PATCH /api/admin/enrollments/:id  — 後台編輯報名基本資料
 * 可編輯欄位：parent_name, parent_phone, students[], coach, course_type,
 *             original_price, final_price, transfer_last_5,
 *             extra_parent_phones[], notes
 * 不可在 cancelled / refunded 狀態下修改（業務資料已結案）。
 */
router.patch('/:id', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const cur = await pool.query(`SELECT * FROM admin_enrollments WHERE id = $1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: '報名不存在' });

    const row = cur.rows[0];
    if (['cancelled', 'refunded'].includes(row.status)) {
      return res.status(400).json({ error: `狀態 ${row.status} 的報名不可再編輯` });
    }

    // 允許部分更新，未傳的欄位保留原值
    const parentName       = body.parent_name       !== undefined ? String(body.parent_name).trim()   : row.parent_name;
    const parentPhone      = body.parent_phone      !== undefined ? String(body.parent_phone).trim()  : row.parent_phone;
    const students         = Array.isArray(body.students)         ? body.students.map((s) => String(s).trim()).filter(Boolean) : row.students;
    const coach            = body.coach             !== undefined ? String(body.coach).trim()          : row.coach;
    const courseType       = body.course_type       !== undefined ? Number(body.course_type)           : row.course_type;
    const originalPrice    = body.original_price    !== undefined ? Number(body.original_price)        : row.original_price;
    const finalPrice       = body.final_price       !== undefined ? Number(body.final_price)           : row.final_price;
    const transferLast5    = body.transfer_last_5   !== undefined ? String(body.transfer_last_5).trim() : row.transfer_last_5;
    const extraPhones      = Array.isArray(body.extra_parent_phones)
      ? body.extra_parent_phones.map((p) => String(p).trim()).filter(Boolean)
      : (row.extra_parent_phones || []);
    const notes            = body.notes             !== undefined ? (body.notes ? String(body.notes).trim() : null) : row.notes;

    if (!parentName) return res.status(400).json({ error: '家長姓名必填' });
    if (!parentPhone) return res.status(400).json({ error: '家長手機必填' });
    if (!students || students.length === 0) return res.status(400).json({ error: '學員名稱必填' });

    await pool.query(
      `UPDATE admin_enrollments SET
         parent_name        = $2,
         parent_phone       = $3,
         students           = $4,
         coach              = $5,
         course_type        = $6,
         original_price     = $7,
         final_price        = $8,
         transfer_last_5    = $9,
         extra_parent_phones = $10,
         notes              = $11,
         updated_at         = NOW()
       WHERE id = $1`,
      [id, parentName, parentPhone, students, coach, courseType,
       originalPrice, finalPrice, transferLast5, extraPhones, notes]
    );

    const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
    await pool.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user) VALUES ($1, $2, $3)`,
      [id, '後台編輯報名資料', by]
    );

    res.json(await readEnrollment(id));
  } catch (err) {
    console.error('[admin/enrollments patch]', err);
    res.status(500).json({ error: 'update failed' });
  }
});

router.post('/:id/reconcile', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const body = req.body || {};
    const by = body.by || req.adminUser?.name || req.adminUser?.username || 'unknown';

    // Task #39：發票號碼 + 圖片 URL 為必填
    const invoiceNumber = (body.invoice_number || '').trim();
    const invoiceImageUrl = (body.invoice_image_url || '').trim();
    const invoiceUrl = (body.invoice_url || '').trim();

    if (!invoiceNumber) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '發票號碼必填' });
    }
    if (!/^[A-Z]{2}\d{8}$/.test(invoiceNumber)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '發票號碼格式錯誤（應為 2 大寫英文 + 8 數字）' });
    }
    if (!invoiceImageUrl) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '發票照片必填' });
    }

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
             invoice_number = $3,
             invoice_image_url = $4,
             invoice_url = $5,
             invoice_issued_at = NOW(),
             updated_at = NOW()
       WHERE id = $1`,
      [id, total, invoiceNumber, invoiceImageUrl, invoiceUrl || null]
    );
    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
       VALUES ($1, $2, $3)`,
      [id, `對帳通過（發票 ${invoiceNumber}）`, by]
    );

    await client.query('COMMIT');

    // 對帳通過 = 等同此筆轉「進行中」→ 立即補對應 course_period 的 chat_room
    try {
      const chatRooms = require('../../services/chatRooms');
      await chatRooms.backfillRoomsForActivePeriods();
    } catch (e) {
      console.warn('[reconcile] backfill chat rooms failed:', e.message);
    }

    // Task #39：推播 LINE Flex 發票通知給家長（含課程資訊）
    try {
      const line = require('../../services/line');
      const enrollment = cur.rows[0];
      const parentPhone = enrollment.parent_phone;
      if (parentPhone) {
        const parentRow = await pool.query(
          `SELECT line_uid FROM parents WHERE phone = $1`, [parentPhone]
        );
        const lineUid = parentRow.rows[0]?.line_uid;
        if (lineUid) {
          const publicBase = (process.env.PUBLIC_BASE_URL || process.env.ADMIN_URL || '').replace(/\/$/, '');
          const absoluteImageUrl = invoiceImageUrl.startsWith('http')
            ? invoiceImageUrl
            : `${publicBase}${invoiceImageUrl}`;
          const liffUrl = process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '';
          // 查場館名稱
          let venueName = enrollment.venue_id;
          try {
            const vRow = await pool.query(`SELECT name FROM admin_venues WHERE id = $1`, [enrollment.venue_id]);
            if (vRow.rows[0]) venueName = vRow.rows[0].name;
          } catch (_) { /* best-effort */ }
          // 組別中文
          const ctMap = { 1: '1 對 1', 2: '1 對 2', 3: '1 對 3' };
          const courseTypeLabel = ctMap[enrollment.course_type] || `1 對 ${enrollment.course_type}`;
          const messages = line.templates.invoiceIssued({
            parentName: enrollment.parent_name,
            invoiceNumber,
            invoiceImageUrl: absoluteImageUrl,
            invoiceUrl: invoiceUrl || null,
            coachName: enrollment.coach,
            venueName,
            courseType: courseTypeLabel,
            finalPrice: enrollment.final_price,
            liffUrl,
          });
          await line.pushMessage(lineUid, messages, enrollment.venue_id);
        }
      }
    } catch (e) {
      console.warn('[reconcile] LINE push invoice failed:', e.message);
    }

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
