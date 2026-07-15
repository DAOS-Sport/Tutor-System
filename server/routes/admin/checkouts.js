const express = require('express');
const { pool } = require('../../models/db');
const {
  requireAdminAuth,
  requireAdminRole,
  getScopedVenueIds,
  isVenueInScope,
} = require('../../middlewares/adminAuth');
const ragicWriteback = require('../../services/ragicWriteback');
const promotions = require('../../services/promotions');
const { logGroupOrderAudit } = require('../../services/groupOrderAudit');
const { CHECKOUT_STATUS, readCheckout } = require('../../services/checkouts');
const enrollmentRouter = require('./enrollments');
const { isGloballyEnabled } = require('../../config/businessFeatureFlags');

const { getSettings, ensureGroupCoursePeriod, ensureSoloCoursePeriod } = enrollmentRouter._checkoutInternals;

const router = express.Router();
const AMS = requireAdminRole('admin', 'manager', 'staff');
const INVOICE_RE = /^[A-Z]{2}\d{8}$/;
const CANCEL_REASON_MAX_LENGTH = 500;

function courseTypeLabel(courseType) {
  return { 1: '1 對 1', 2: '1 對 2', 3: '1 對 3' }[Number(courseType)] || `1 對 ${courseType}`;
}

function scopedCheckoutWhere(req, params) {
  const where = [];
  const scope = getScopedVenueIds(req);
  if (scope) {
    if (!scope.length) where.push('FALSE');
    else {
      params.push(scope);
      const scopeParam = params.length;
      // 一張 checkout 是所有子訂單的原子操作單位：若只靠 EXISTS 選到「其中一筆」
      // 所屬場館，再由 readCheckout 聚合全部子訂單，便會把未授權場館資料洩漏給櫃檯。
      // 非 admin 必須同時滿足：至少有一筆在 scope，且不存在任何 scope 外（含 NULL）的子單。
      // 不做部分投影，避免 UI 看得到卻不能對帳/取消的半張 checkout。
      where.push(`EXISTS (
        SELECT 1 FROM admin_enrollments ae_scope
         WHERE ae_scope.checkout_id = cs.checkout_id
           AND ae_scope.venue_id = ANY($${scopeParam}::text[])
      ) AND NOT EXISTS (
        SELECT 1 FROM admin_enrollments ae_outside_scope
         WHERE ae_outside_scope.checkout_id = cs.checkout_id
           AND (
             ae_outside_scope.venue_id IS NULL
             OR NOT (ae_outside_scope.venue_id = ANY($${scopeParam}::text[]))
           )
      )`);
    }
  }
  if (req.query.venueId) {
    const venueId = String(req.query.venueId);
    if (!isVenueInScope(req, venueId)) where.push('FALSE');
    else {
      params.push(venueId);
      where.push(`EXISTS (
        SELECT 1 FROM admin_enrollments ae_venue
         WHERE ae_venue.checkout_id = cs.checkout_id
           AND ae_venue.venue_id = $${params.length}
      )`);
    }
  }
  return where;
}

router.get('/', requireAdminAuth, AMS, async (req, res) => {
  try {
    const params = [];
    const where = scopedCheckoutWhere(req, params);

    const status = req.query.status ? String(req.query.status) : '';
    if (status === 'pending') {
      where.push(`cs.payment_status IN ('pending_payment','pending_reconcile')`);
    } else if (status) {
      params.push(status);
      where.push(`cs.payment_status = $${params.length}`);
    }

    const search = req.query.search ? String(req.query.search).trim().toLowerCase() : '';
    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      where.push(`(
        LOWER(cs.checkout_id::text) LIKE $${idx}
        OR LOWER(COALESCE(p.name, '')) LIKE $${idx}
        OR COALESCE(p.phone, '') LIKE $${idx}
        OR EXISTS (
          SELECT 1 FROM admin_enrollments ae_search
           WHERE ae_search.checkout_id = cs.checkout_id
             AND (
               LOWER(ae_search.id) LIKE $${idx}
               OR LOWER(ae_search.parent_name) LIKE $${idx}
               OR ae_search.parent_phone LIKE $${idx}
               OR LOWER(ae_search.coach) LIKE $${idx}
               OR EXISTS (SELECT 1 FROM unnest(ae_search.students) s WHERE LOWER(s) LIKE $${idx})
             )
        )
      )`);
    }

    const r = await pool.query(
      `SELECT cs.checkout_id
         FROM checkout_sessions cs
         LEFT JOIN parents p ON p.id = cs.parent_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY cs.created_at DESC
        LIMIT 500`,
      params
    );
    const out = [];
    for (const row of r.rows) out.push(await readCheckout(pool, row.checkout_id));
    res.json(out.filter(Boolean));
  } catch (err) {
    console.error('[admin/checkouts GET]', err);
    res.status(500).json({ error: '載入付款單失敗' });
  }
});

router.get('/:checkoutId', requireAdminAuth, AMS, async (req, res) => {
  try {
    const checkout = await readCheckout(pool, req.params.checkoutId);
    if (!checkout) return res.status(404).json({ error: '找不到付款單' });
    if (!(checkout.sub_orders || []).every((row) => isVenueInScope(req, row.venue_id))) {
      return res.status(403).json({ error: '此付款單含有您無權檢視的場館' });
    }
    res.json(checkout);
  } catch (err) {
    console.error('[admin/checkouts GET /:id]', err);
    res.status(500).json({ error: '載入付款單失敗' });
  }
});

router.post('/:checkoutId/reconcile', requireAdminAuth, AMS, async (req, res) => {
  const client = await pool.connect();
  const createdStudentIds = [];
  try {
    await client.query('BEGIN');
    // 稽核操作者只能取自已驗證的後台 JWT；不可接受 client 自填的 by，
    // 否則任何有權呼叫者都能偽造對帳／發票的操作者紀錄。
    const by = req.adminUser?.name || req.adminUser?.username || req.adminUser?.sub || 'unknown';
    const invoiceNumber = String(req.body?.invoice_number || '').trim().toUpperCase();
    const invoiceImageUrl = String(req.body?.invoice_image_url || '').trim();
    const invoiceUrl = String(req.body?.invoice_url || '').trim();
    const buyerName = String(req.body?.buyer_name || '').trim() || null;
    const taxId = String(req.body?.tax_id || '').trim() || null;

    if (!invoiceNumber) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '發票號碼必填' });
    }
    if (!INVOICE_RE.test(invoiceNumber)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '發票號碼格式錯誤（應為 2 大寫英文 + 8 數字）' });
    }
    if (!invoiceImageUrl) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '發票照片必填' });
    }

    const cr = await client.query(`SELECT * FROM checkout_sessions WHERE checkout_id = $1 FOR UPDATE`, [req.params.checkoutId]);
    if (!cr.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到付款單' });
    }
    const checkoutRow = cr.rows[0];
    if (![CHECKOUT_STATUS.PENDING_PAYMENT, CHECKOUT_STATUS.PENDING_RECONCILE].includes(checkoutRow.payment_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此付款單狀態非待對帳' });
    }

    const children = await client.query(
      `SELECT * FROM admin_enrollments
        WHERE checkout_id = $1
        ORDER BY submitted_at, period_number, id
        FOR UPDATE`,
      [req.params.checkoutId]
    );
    if (!children.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '此付款單沒有子訂單' });
    }
    if (!children.rows.every((row) => isVenueInScope(req, row.venue_id))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此付款單含有您無權對帳的場館' });
    }
    if (children.rows.some((row) => row.status !== 'pending_payment')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此付款單含有非待對帳子訂單，請重新整理後再試' });
    }

    const onsiteTrialV2 = isGloballyEnabled('TRIAL_ONSITE_CHECKOUT_V2')
      && checkoutRow.payment_method === 'on_site'
      && checkoutRow.order_kind === 'trial'
      && children.rows.every((row) => row.order_kind === 'trial' && row.payment_method === 'on_site');
    let onsiteCollection = null;
    if (onsiteTrialV2) {
      const venueId = String(req.body?.collection_venue_id || '').trim();
      const amount = Number(req.body?.collected_amount);
      const expectedAmount = Number(checkoutRow.total_amount);
      if (!venueId || !children.rows.some((row) => String(row.venue_id) === venueId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '現場收款場館必填且須屬於訂單', code: 'COLLECTION_VENUE_REQUIRED' });
      }
      if (!Number.isFinite(amount) || Math.round(amount * 100) !== Math.round(expectedAmount * 100)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '現場收款金額須與付款單一致', code: 'COLLECTION_AMOUNT_MISMATCH' });
      }
      onsiteCollection = { venueId, amount };
    }

    const settings = await getSettings();
    const perPeriod = settings.sessions_per_period || 6;
    const groupPaymentMarked = new Set();
    const rowsToOpen = [];
    for (const row of children.rows) {
      // 試上是明確的一次課；不可因 checkout 批次對帳被通用每期堂數放大成 6 堂。
      const total = row.order_kind === 'trial'
        ? 1
        : (Number(row.total_sessions) || perPeriod * (Number(row.period_count) || 1));
      await client.query(
        `UPDATE admin_enrollments
            SET status = 'confirmed',
                total_sessions = $2,
                used_sessions = COALESCE(used_sessions, 0),
                invoice_number = $3,
                invoice_image_url = $4,
                invoice_url = $5,
                invoice_issued_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [row.id, total, invoiceNumber, invoiceImageUrl, invoiceUrl || null]
      );
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
         VALUES ($1, $2, $3)`,
        [row.id, `checkout 對帳通過（發票 ${invoiceNumber}）`, by]
      );

      if (row.group_order_id) {
        const groupKey = `${row.group_order_id}:${row.parent_phone}`;
        if (!groupPaymentMarked.has(groupKey)) {
          groupPaymentMarked.add(groupKey);
          const gconf = await client.query(
            `UPDATE group_order_members gom
                SET payment_confirmed = TRUE,
                    payment_confirmed_at = NOW(),
                    payment_confirmed_by = $3
              FROM parents p
              WHERE p.id = gom.parent_id
                AND gom.group_order_id = $1
                AND p.phone = $2
                AND gom.payment_confirmed = FALSE`,
            [row.group_order_id, row.parent_phone, String(by).slice(0, 50)]
          );
          if (gconf.rowCount) {
            await logGroupOrderAudit(client, {
              groupOrderId: row.group_order_id,
              action: `櫃檯確認帳款（${row.parent_name}／${row.parent_phone}，checkout 對帳通過，發票 ${invoiceNumber}）`,
              by,
            });
          }
        }
      }
      rowsToOpen.push({ row, total });
    }

    await client.query(
      `INSERT INTO checkout_invoices
         (checkout_id, order_id, buyer_name, tax_id, amount, invoice_number, invoice_image_url, invoice_url, issued_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (checkout_id) WHERE order_id IS NULL
       DO UPDATE SET buyer_name = EXCLUDED.buyer_name,
                     tax_id = EXCLUDED.tax_id,
                     amount = EXCLUDED.amount,
                     invoice_number = EXCLUDED.invoice_number,
                     invoice_image_url = EXCLUDED.invoice_image_url,
                     invoice_url = EXCLUDED.invoice_url,
                     issued_at = EXCLUDED.issued_at,
                     updated_at = NOW()`,
      [
        req.params.checkoutId,
        buyerName || children.rows[0].parent_name,
        taxId || children.rows[0].tax_id || null,
        Number(checkoutRow.total_amount) || children.rows.reduce((sum, row) => sum + (Number(row.final_price) || 0), 0),
        invoiceNumber,
        invoiceImageUrl,
        invoiceUrl || null,
      ]
    );
    await client.query(
      `UPDATE checkout_sessions
          SET payment_status = 'paid',
              current_route_state = 'paid',
              audit_log = COALESCE(audit_log, '[]'::jsonb) ||
                jsonb_build_array(jsonb_build_object('at', NOW(), 'action', 'checkout_reconciled', 'by', $2::text, 'invoice_number', $3::text)),
              updated_at = NOW()
        WHERE checkout_id = $1`,
      [req.params.checkoutId, by, invoiceNumber]
    );
    if (onsiteCollection) {
      await client.query(
        `INSERT INTO onsite_payment_collections
           (checkout_id, operator_id, operator_name, venue_id, amount, collected_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (checkout_id) DO NOTHING`,
        [req.params.checkoutId, String(req.adminUser?.sub || req.adminUser?.username || 'unknown'),
          String(by), onsiteCollection.venueId, onsiteCollection.amount]
      );
      await client.query(
        `UPDATE checkout_sessions SET onsite_payment_status = 'PAID' WHERE checkout_id = $1`,
        [req.params.checkoutId]
      );
    }

    for (const { row, total } of rowsToOpen) {
      await ensureGroupCoursePeriod(client, row, total);
      const ids = (await ensureSoloCoursePeriod(client, row, total)) || [];
      createdStudentIds.push(...ids);
    }

    await client.query('COMMIT');

    if (createdStudentIds.length) {
      ragicWriteback.scheduleWriteback({ studentIds: createdStudentIds, reason: 'checkout-reconcile' });
    }
    try {
      const chatRooms = require('../../services/chatRooms');
      await chatRooms.backfillRoomsForActivePeriods();
    } catch (e) {
      console.warn('[checkout reconcile] backfill chat rooms failed:', e.message);
    }
    try {
      const line = require('../../services/line');
      const checkout = await readCheckout(pool, req.params.checkoutId);
      const first = checkout.sub_orders[0] || {};
      const parentQuery = checkout.parent_id
        ? await pool.query(`SELECT id, line_uid FROM parents WHERE id = $1`, [checkout.parent_id])
        : await pool.query(`SELECT id, line_uid FROM parents WHERE phone = $1`, [checkout.parent_phone]);
      const lineUid = parentQuery.rows[0]?.line_uid;
      const notificationV2 = isGloballyEnabled('LINE_NOTIFICATION_BINDING_V2');
      if ((notificationV2 ? parentQuery.rows[0]?.id : lineUid) && first.venue_id) {
        const publicBase = (process.env.PUBLIC_BASE_URL || process.env.ADMIN_URL || '').replace(/\/$/, '');
        const absoluteImageUrl = invoiceImageUrl.startsWith('http') ? invoiceImageUrl : `${publicBase}${invoiceImageUrl}`;
        const liffUrl = process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '';
        const courseTypes = [...new Set(checkout.sub_orders.map((o) => o.course_type).filter(Boolean))];
        const messages = line.templates.invoiceIssued({
          parentName: checkout.parent_name,
          invoiceNumber,
          invoiceImageUrl: absoluteImageUrl,
          invoiceUrl: invoiceUrl || null,
          coachName: checkout.sub_orders.length === 1 ? first.coach : `${checkout.sub_orders.length} 筆子訂單`,
          venueName: checkout.venue?.name || first.venue_id,
          courseType: courseTypes.length === 1 ? courseTypeLabel(courseTypes[0]) : `${courseTypes.length} 種組別`,
          finalPrice: checkout.total_amount,
          liffUrl,
        });
        if (notificationV2) {
          const jobs = require('../../services/notificationJobs');
          await jobs.enqueueParentNotification({
            eventName: 'invoice_issued',
            refId: req.params.checkoutId,
            parentId: parentQuery.rows[0].id,
            venueId: first.venue_id,
            messages,
          });
          jobs.scheduleNotificationJobs();
        } else {
          await line.pushMessage(lineUid, messages, first.venue_id);
        }
      }
    } catch (e) {
      console.warn('[checkout reconcile] LINE push invoice failed:', e.message);
    }

    res.json(await readCheckout(pool, req.params.checkoutId));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/checkouts reconcile]', err);
    if (err?.code === 'GROUP_PERIOD_SCHEMA_UPGRADE_REQUIRED') {
      return res.status(err.statusCode || 409).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: 'checkout reconcile failed' });
  } finally {
    client.release();
  }
});

router.post('/:checkoutId/cancel', requireAdminAuth, AMS, async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: '取消原因必填' });
  if (reason.length > CANCEL_REASON_MAX_LENGTH) {
    return res.status(400).json({ error: `取消原因不可超過 ${CANCEL_REASON_MAX_LENGTH} 字` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 稽核操作者必須來自已驗證 token，不接受 client 自填 by 竄改紀錄。
    const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
    const byUserId = req.adminUser?.sub || null;
    const cr = await client.query(`SELECT * FROM checkout_sessions WHERE checkout_id = $1 FOR UPDATE`, [req.params.checkoutId]);
    if (!cr.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到付款單' });
    }
    const checkoutRow = cr.rows[0];
    if (![CHECKOUT_STATUS.PENDING_PAYMENT, CHECKOUT_STATUS.PENDING_RECONCILE].includes(checkoutRow.payment_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此付款單狀態非待對帳，無法取消' });
    }
    const children = await client.query(
      `SELECT * FROM admin_enrollments WHERE checkout_id = $1 FOR UPDATE`,
      [req.params.checkoutId]
    );
    if (!children.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '此付款單沒有子訂單' });
    }
    if (!children.rows.every((row) => isVenueInScope(req, row.venue_id))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此付款單含有您無權取消的場館' });
    }
    if (children.rows.some((row) => row.status !== 'pending_payment')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此付款單含有非待對帳子訂單，無法取消' });
    }
    for (const row of children.rows) {
      await promotions.revertUsage({ adminEnrollmentId: row.id }, client);
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason)
         VALUES ($1, $2, $3, $4)`,
        [row.id, `取消 checkout（原始狀態：${row.status}）`, by, reason]
      );
    }
    await client.query(
      `UPDATE admin_enrollments SET status = 'cancelled', updated_at = NOW() WHERE checkout_id = $1`,
      [req.params.checkoutId]
    );
    await client.query(
      `UPDATE checkout_sessions
          SET payment_status = 'cancelled',
              current_route_state = 'cancelled',
              audit_log = COALESCE(audit_log, '[]'::jsonb) ||
                jsonb_build_array(jsonb_build_object(
                  'at', NOW(),
                  'action', 'checkout_cancelled',
                  'by', $2::text,
                  'by_user_id', $3::text,
                  'reason', $4::text,
                  'from_payment_status', $5::text,
                  'from_route_state', $6::text
                )),
              updated_at = NOW()
        WHERE checkout_id = $1`,
      [
        req.params.checkoutId,
        by,
        byUserId,
        reason,
        checkoutRow.payment_status,
        checkoutRow.current_route_state || checkoutRow.payment_status,
      ]
    );
    await client.query('COMMIT');
    res.json(await readCheckout(pool, req.params.checkoutId));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/checkouts cancel]', err);
    res.status(500).json({ error: '取消付款單失敗' });
  } finally {
    client.release();
  }
});

module.exports = router;
