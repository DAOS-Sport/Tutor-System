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
const { requireAdminAuth, requireAdminRole, getScopedVenueIds, isVenueInScope } = require('../../middlewares/adminAuth');

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
    coach_id: row.coach_id || null,
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
    // Task #90：場館範圍 — staff/manager 鎖在自己所屬全部場館；admin 可帶 venueId 自由查
    const scope = getScopedVenueIds(req);
    const where = [];
    const args = [];
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    if (scope) {
      args.push(scope);
      where.push(`venue_id = ANY($${args.length}::text[])`);
      // manager 可在自己場館範圍內再用 venueId 縮小
      if (req.query.venueId && scope.includes(String(req.query.venueId))) {
        args.push(String(req.query.venueId));
        where.push(`venue_id = $${args.length}`);
      }
    } else if (req.query.venueId) {
      args.push(req.query.venueId);
      where.push(`venue_id = $${args.length}`);
    }
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const body = req.body || {};
    const cur = await client.query(`SELECT * FROM admin_enrollments WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '報名不存在' });
    }

    const row = cur.rows[0];
    if (!isVenueInScope(req, row.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
    }
    if (['cancelled', 'refunded'].includes(row.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `狀態 ${row.status} 的報名不可再編輯` });
    }

    // 允許部分更新，未傳的欄位保留原值
    const parentName       = body.parent_name       !== undefined ? String(body.parent_name).trim()   : row.parent_name;
    const parentPhone      = body.parent_phone      !== undefined ? String(body.parent_phone).trim()  : row.parent_phone;
    const students         = Array.isArray(body.students)         ? body.students.map((s) => String(s).trim()).filter(Boolean) : row.students;
    const courseType       = body.course_type       !== undefined ? Number(body.course_type)           : row.course_type;
    const originalPrice    = body.original_price    !== undefined ? Number(body.original_price)        : row.original_price;
    const finalPrice       = body.final_price       !== undefined ? Number(body.final_price)           : row.final_price;
    const transferLast5    = body.transfer_last_5   !== undefined ? String(body.transfer_last_5).trim() : row.transfer_last_5;
    const extraPhones      = Array.isArray(body.extra_parent_phones)
      ? body.extra_parent_phones.map((p) => String(p).trim()).filter(Boolean)
      : (row.extra_parent_phones || []);
    const notes            = body.notes             !== undefined ? (body.notes ? String(body.notes).trim() : null) : row.notes;

    // venue / coach 變更：venue_id 走 admin_venues 驗證；coach_id 走 coaches + coach_venues 驗證
    let venueId  = row.venue_id;
    let venueName = null;
    let coachId   = row.coach_id || null;
    let coachName = row.coach;

    if (body.venue_id !== undefined) {
      venueId = String(body.venue_id).trim();
      // Task #90：變更場館時，目標場館必須在自己所屬範圍內（manager 不能把報名搬到別館）
      if (!isVenueInScope(req, venueId)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: '目標場館不在您的場館範圍內' });
      }
      const vr = await client.query(`SELECT id, name FROM admin_venues WHERE id = $1`, [venueId]);
      if (!vr.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `場館不存在：${venueId}` });
      }
      venueName = vr.rows[0].name;
    }
    if (body.coach_id !== undefined && body.coach_id) {
      coachId = String(body.coach_id).trim();
      const cr = await client.query(
        `SELECT c.id, c.name FROM coaches c WHERE c.id = $1 AND c.is_active = TRUE`,
        [coachId]
      );
      if (!cr.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '教練不存在或已停用' });
      }
      coachName = cr.rows[0].name;
      // 驗證該教練屬於目標場館
      const cv = await client.query(
        `SELECT 1 FROM coach_venues WHERE coach_id = $1 AND venue_id = $2`,
        [coachId, venueId]
      );
      if (!cv.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '此教練不在所選場館' });
      }
    } else if (body.coach !== undefined) {
      // 向後相容：純文字編輯（不指定 coach_id）
      coachName = String(body.coach).trim();
    }

    if (!parentName) { await client.query('ROLLBACK'); return res.status(400).json({ error: '家長姓名必填' }); }
    if (!parentPhone) { await client.query('ROLLBACK'); return res.status(400).json({ error: '家長手機必填' }); }
    if (!students || students.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: '學員名稱必填' }); }
    if (!coachName) { await client.query('ROLLBACK'); return res.status(400).json({ error: '教練必填' }); }
    // 一致性硬規則：venue_id 變更時必須在同一 request 顯式帶 coach_id
    // （避免直接打 API 只改場館卻沿用舊教練 → venue/coach 不匹配）
    if (venueId !== row.venue_id && (body.coach_id === undefined || !body.coach_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '變更場館時必須同時指定該場館的教練（coach_id）' });
    }

    await client.query(
      `UPDATE admin_enrollments SET
         parent_name        = $2,
         parent_phone       = $3,
         students           = $4,
         coach              = $5,
         coach_id           = $6,
         venue_id           = $7,
         course_type        = $8,
         original_price     = $9,
         final_price        = $10,
         transfer_last_5    = $11,
         extra_parent_phones = $12,
         notes              = $13,
         updated_at         = NOW()
       WHERE id = $1`,
      [id, parentName, parentPhone, students, coachName, coachId, venueId, courseType,
       originalPrice, finalPrice, transferLast5, extraPhones, notes]
    );

    const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
    const oldCoachName  = row.coach;
    const oldVenueId    = row.venue_id;
    const venueChanged  = venueId !== oldVenueId;
    const coachChanged  = (coachId && coachId !== row.coach_id) || (coachName !== oldCoachName);
    let reassignedSessions = 0;

    // 教練 / 場館變更 → 同步未來尚未上課的 sessions（best-effort）
    // 透過 course_periods.admin_enrollment_id 軟連結；舊資料無連結時，這裡用
    // (parent_phone + 舊 coach + 舊 venue) 做一次 lazy backfill，讓首次轉教練也能生效。
    if ((coachChanged || venueChanged) && coachId) {
      // Resolve 舊 coach UUID（admin_enrollments.coach_id 在升級前可能為 NULL，靠名稱反查）
      let oldCoachUuid = row.coach_id;
      if (!oldCoachUuid && row.coach && row.venue_id) {
        const r2 = await client.query(
          `SELECT c.id FROM coaches c
             JOIN coach_venues cv ON cv.coach_id = c.id
            WHERE c.name = $1 AND cv.venue_id = $2 LIMIT 1`,
          [row.coach, row.venue_id]
        );
        if (r2.rowCount) oldCoachUuid = r2.rows[0].id;
      }
      // Lazy backfill admin_enrollment_id（嚴格安全模式）：
      //   只有在 (parent_phone + 舊 coach + 舊 venue + course_type) 命中且
      //   ① 該 parent 在系統內僅有一筆同條件之 admin_enrollment（即本筆）
      //   ② 命中的 period 也尚未被任何其他 admin_enrollment_id 連結
      //   時才執行，避免多筆同手機/同教練的報名互相錯置。
      if (oldCoachUuid) {
        const ambiguity = await client.query(
          `SELECT COUNT(*)::int AS n FROM admin_enrollments
            WHERE parent_phone = $1 AND course_type = $2
              AND COALESCE(coach_id, '00000000-0000-0000-0000-000000000000'::uuid) = $3
              AND venue_id = $4`,
          [row.parent_phone, row.course_type, oldCoachUuid, row.venue_id]
        );
        if (ambiguity.rows[0].n <= 1) {
          await client.query(
            `UPDATE course_periods cp
                SET admin_enrollment_id = $1
              WHERE cp.admin_enrollment_id IS NULL
                AND cp.coach_id = $2
                AND cp.venue_id = $3
                AND cp.course_type = $5
                AND EXISTS (
                  SELECT 1 FROM course_period_enrollments cpe
                    JOIN students s ON s.id = cpe.student_id
                    JOIN parents  p ON p.id = s.parent_id
                   WHERE cpe.course_period_id = cp.id AND p.phone = $4
                )`,
            [id, oldCoachUuid, row.venue_id, row.parent_phone, row.course_type]
          );
        }
      }
      const periods = await client.query(
        `SELECT id FROM course_periods WHERE admin_enrollment_id = $1`, [id]
      );
      const periodIds = periods.rows.map((r) => r.id);
      if (periodIds.length > 0) {
        // 1) 更新 period 主檔（讓教練 LIFF 的「我的學員 / 今日課程」立即看到）
        await client.query(
          `UPDATE course_periods SET coach_id = $2, venue_id = $3, updated_at = NOW()
             WHERE id = ANY($1::uuid[])`,
          [periodIds, coachId, venueId]
        );
        // 2) 只覆寫未來尚未上課的 sessions 之 coach_id（已上課保留原值）
        const upd = await client.query(
          `UPDATE course_sessions
              SET coach_id = $2, updated_at = NOW()
            WHERE course_period_id = ANY($1::uuid[])
              AND scheduled_at > NOW()
              AND status IN ('confirmed','pending_group_confirm')`,
          [periodIds, coachId]
        );
        reassignedSessions = upd.rowCount || 0;
      }
    }

    // Audit log
    if (coachChanged || venueChanged) {
      const reasonParts = [];
      if (venueChanged) reasonParts.push(`場館 ${oldVenueId} → ${venueId}`);
      if (coachChanged) reasonParts.push(`教練 ${oldCoachName} → ${coachName}`);
      if (reassignedSessions > 0) reasonParts.push(`重新指派 ${reassignedSessions} 堂未來課程`);
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs
           (enrollment_id, action, by_user, reason,
            before_coach_id, after_coach_id, before_coach, after_coach,
            before_venue_id, after_venue_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, 'transfer_coach', by, reasonParts.join('；'),
         row.coach_id || null, coachId || null, oldCoachName || null, coachName || null,
         oldVenueId || null, venueId || null]
      );
    } else {
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user) VALUES ($1, $2, $3)`,
        [id, '後台編輯報名資料', by]
      );
    }

    await client.query('COMMIT');
    const out = await readEnrollment(id);
    res.json({ ...out, _transfer: { coach_changed: coachChanged, venue_changed: venueChanged, reassigned_sessions: reassignedSessions } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/enrollments patch]', err);
    res.status(500).json({ error: 'update failed' });
  } finally {
    client.release();
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
    if (!isVenueInScope(req, cur.rows[0].venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
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
    if (!isVenueInScope(req, preview.enrollment.venue_id)) {
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
    }
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
    if (!isVenueInScope(req, preview.enrollment.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
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
