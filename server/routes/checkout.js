const express = require('express');
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const { objectExists } = require('../services/objectStorage');
const promotions = require('../services/promotions');
const {
  CHECKOUT_STATUS,
  createCheckoutSession,
  refreshCheckoutTotal,
  readCheckout,
  routeInstruction,
} = require('../services/checkouts');

const router = express.Router();
router.use(requireParent);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROOF_URL_RE = /^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{24}\.(jpg|jpeg|png)$/;

function ownsCheckout(checkout, parent) {
  if (!checkout) return false;
  if (checkout.parent_id && checkout.parent_id === parent.id) return true;
  const phone = parent.phone;
  return (checkout.sub_orders || []).some((o) => (
    o.parent_phone === phone || (o.extra_parent_phones || []).includes(phone)
  ));
}

router.post('/route', async (req, res) => {
  const batchId = String(req.body?.enrollment_batch_id || req.body?.batch_id || '').trim();
  if (!UUID_RE.test(batchId)) {
    return res.status(400).json({ error: 'enrollment_batch_id 格式錯誤', code: 'BATCH_ID_INVALID' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ownRows = await client.query(
      `SELECT *
         FROM admin_enrollments
        WHERE enrollment_batch_id = $1
          AND parent_phone = $2
          AND status = 'pending_payment'
        ORDER BY submitted_at, period_number, id
        FOR UPDATE`,
      [batchId, req.parent.phone]
    );
    if (!ownRows.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到此家長可結帳的子訂單', code: 'NO_OWN_SUB_ORDERS' });
    }

    const existingCheckoutIds = [...new Set(ownRows.rows.map((row) => row.checkout_id).filter(Boolean))];
    if (existingCheckoutIds.length > 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此批次已有多個付款單，請聯繫櫃檯', code: 'CHECKOUT_SPLIT_CONFLICT' });
    }

    const totalAmount = ownRows.rows.reduce((sum, row) => sum + (Number(row.final_price) || 0), 0);
    const first = ownRows.rows[0];
    const checkout = await createCheckoutSession(client, {
      parentId: req.parent.id,
      enrollmentBatchId: batchId,
      totalAmount,
      transferLast5: first.transfer_last_5 || null,
      paymentProofUrl: first.payment_proof_url || null,
      carrier: first.carrier || null,
      by: req.parent.phone,
    });

    await client.query(
      `UPDATE admin_enrollments
          SET checkout_id = $3,
              updated_at = NOW()
        WHERE enrollment_batch_id = $1
          AND parent_phone = $2
          AND status = 'pending_payment'
          AND (checkout_id IS NULL OR checkout_id = $3)`,
      [batchId, req.parent.phone, checkout.checkoutId]
    );
    await refreshCheckoutTotal(client, checkout.checkoutId);
    await client.query('COMMIT');

    const instruction = routeInstruction(checkout.checkoutId, checkout.paymentStatus);
    const totalCheck = await pool.query(
      `SELECT total_amount FROM checkout_sessions WHERE checkout_id = $1`,
      [checkout.checkoutId]
    );
    const checkoutTotalAmount = Number(totalCheck.rows[0]?.total_amount ?? totalAmount) || 0;
    res.json({
      status: 'success',
      ok: true,
      checkout_id: checkout.checkoutId,
      ...instruction,
      data: { ...instruction, total_amount: checkoutTotalAmount },
      route_instruction: instruction,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[checkout route]', err);
    res.status(500).json({ error: '建立付款導向失敗' });
  } finally {
    client.release();
  }
});

router.get('/:checkoutId', async (req, res) => {
  try {
    const { checkoutId } = req.params;
    if (!UUID_RE.test(checkoutId)) return res.status(404).json({ error: '找不到此付款單' });
    const checkout = await readCheckout(pool, checkoutId);
    if (!checkout) return res.status(404).json({ error: '找不到此付款單' });
    if (!ownsCheckout(checkout, req.parent)) return res.status(403).json({ error: '無權檢視此付款單' });
    res.json(checkout);
  } catch (err) {
    console.error('[checkout GET]', err);
    res.status(500).json({ error: '載入付款單失敗' });
  }
});

router.post('/:checkoutId/payment-proof', async (req, res) => {
  const { checkoutId } = req.params;
  if (!UUID_RE.test(checkoutId)) return res.status(404).json({ error: '找不到此付款單' });

  const url = typeof req.body?.payment_proof_url === 'string' ? req.body.payment_proof_url.trim() : '';
  const last5 = typeof req.body?.transfer_last_5 === 'string' ? req.body.transfer_last_5.trim() : '';
  const carrier = typeof req.body?.carrier === 'string' ? req.body.carrier.trim().slice(0, 64) : '';

  if (last5 && !/^\d{5}$/.test(last5)) {
    return res.status(400).json({ error: '轉帳末 5 碼需為 5 位數字', code: 'TRANSFER_LAST5_INVALID' });
  }
  if (url && (!PROOF_URL_RE.test(url) || !objectExists(url))) {
    return res.status(400).json({ error: '請上傳有效的匯款／轉帳證明', code: 'PAYMENT_PROOF_INVALID' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM checkout_sessions WHERE checkout_id = $1 FOR UPDATE`,
      [checkoutId]
    );
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到此付款單' });
    }
    const checkout = await readCheckout(client, checkoutId);
    if (!ownsCheckout(checkout, req.parent)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '無權操作此付款單' });
    }
    if (![CHECKOUT_STATUS.PENDING_PAYMENT, CHECKOUT_STATUS.PENDING_RECONCILE].includes(locked.rows[0].payment_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此付款單狀態無法再上傳證明', code: 'NOT_PENDING' });
    }
    if (locked.rows[0].transfer_last_5 && locked.rows[0].payment_proof_url) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '付款資料已送出，如需更改請聯繫櫃檯', code: 'PAYMENT_LOCKED' });
    }
    if (!url && !locked.rows[0].payment_proof_url && !last5 && !carrier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '請填寫轉帳末 5 碼或上傳匯款／轉帳證明', code: 'PAYMENT_INFO_REQUIRED' });
    }

    const nextLast5 = last5 || locked.rows[0].transfer_last_5 || null;
    const nextProofUrl = url || locked.rows[0].payment_proof_url || null;
    const nextCarrier = carrier || locked.rows[0].carrier || null;
    const nextStatus = (nextLast5 || nextProofUrl)
      ? CHECKOUT_STATUS.PENDING_RECONCILE
      : CHECKOUT_STATUS.PENDING_PAYMENT;

    await client.query(
      `UPDATE checkout_sessions
          SET transfer_last_5 = $2,
              payment_proof_url = $3,
              carrier = $4,
              payment_status = $5,
              current_route_state = $5,
              audit_log = COALESCE(audit_log, '[]'::jsonb) ||
                jsonb_build_array(jsonb_build_object('at', NOW(), 'action', 'payment_submitted', 'by', 'parent')),
              updated_at = NOW()
        WHERE checkout_id = $1`,
      [checkoutId, nextLast5, nextProofUrl, nextCarrier, nextStatus]
    );
    await client.query(
      `UPDATE admin_enrollments
          SET transfer_last_5 = COALESCE($2, transfer_last_5),
              payment_proof_url = COALESCE($3, payment_proof_url),
              carrier = COALESCE($4, carrier),
              updated_at = NOW()
        WHERE checkout_id = $1
          AND status = 'pending_payment'`,
      [checkoutId, last5 || null, url || null, carrier || null]
    );

    await client.query('COMMIT');
    res.json(await readCheckout(pool, checkoutId));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[checkout payment-proof]', err);
    res.status(500).json({ error: '送出付款資料失敗' });
  } finally {
    client.release();
  }
});

router.post('/:checkoutId/cancel', async (req, res) => {
  const { checkoutId } = req.params;
  if (!UUID_RE.test(checkoutId)) return res.status(404).json({ error: '找不到此付款單' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM checkout_sessions WHERE checkout_id = $1 FOR UPDATE`,
      [checkoutId]
    );
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到此付款單' });
    }
    const children = await client.query(
      `SELECT * FROM admin_enrollments WHERE checkout_id = $1 FOR UPDATE`,
      [checkoutId]
    );
    const checkout = await readCheckout(client, checkoutId);
    if (!ownsCheckout(checkout, req.parent)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '無權取消此付款單' });
    }
    if (children.rows.some((row) => row.group_order_id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '團報請至團購狀態頁處理取消', code: 'GROUP_ORDER_CANCEL_REQUIRED' });
    }
    if (!children.rows.length || children.rows.some((row) => row.status !== 'pending_payment')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此付款單已進入處理流程，無法由家長取消', code: 'NOT_PENDING' });
    }

    await client.query(
      `UPDATE admin_enrollments
          SET status = 'cancelled',
              updated_at = NOW()
        WHERE checkout_id = $1`,
      [checkoutId]
    );
    for (const row of children.rows) {
      await promotions.revertUsage({ adminEnrollmentId: row.id }, client);
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason)
         VALUES ($1, '家長取消未完成付款單', 'parent', '家長於 LIFF 取消 checkout')`,
        [row.id]
      );
    }
    await client.query(
      `UPDATE checkout_sessions
          SET payment_status = 'cancelled',
              current_route_state = 'cancelled',
              audit_log = COALESCE(audit_log, '[]'::jsonb) ||
                jsonb_build_array(jsonb_build_object('at', NOW(), 'action', 'checkout_cancelled', 'by', 'parent')),
              updated_at = NOW()
        WHERE checkout_id = $1`,
      [checkoutId]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[checkout cancel]', err);
    res.status(500).json({ error: '取消失敗' });
  } finally {
    client.release();
  }
});

module.exports = router;
