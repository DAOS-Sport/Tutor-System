const express = require('express');
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const { parseProofInput } = require('../services/paymentProof');
const {
  validateRequestId,
  payloadFingerprint,
  acquireRequestLock,
} = require('../services/idempotency');
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
const CHECKOUT_ROUTE_OPERATION = 'route_checkout_session';

function ownsCheckout(checkout, parent) {
  if (!checkout) return false;
  if (checkout.parent_id && checkout.parent_id === parent.id) return true;
  const phone = parent.phone;
  return (checkout.sub_orders || []).some((o) => (
    o.parent_phone === phone || (o.extra_parent_phones || []).includes(phone)
  ));
}

router.post('/route', async (req, res) => {
  const requestCheck = validateRequestId(req.body?.request_id || req.get('Idempotency-Key'));
  if (requestCheck.error) {
    return res.status(requestCheck.status).json({ error: requestCheck.error, code: requestCheck.code });
  }
  const requestId = requestCheck.requestId;
  const batchId = String(req.body?.enrollment_batch_id || req.body?.batch_id || '').trim();
  if (!UUID_RE.test(batchId)) {
    return res.status(400).json({ error: 'enrollment_batch_id 格式錯誤', code: 'BATCH_ID_INVALID' });
  }
  const fingerprint = payloadFingerprint({ enrollment_batch_id: batchId });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireRequestLock(client, {
      actorId: req.parent.id,
      operation: CHECKOUT_ROUTE_OPERATION,
      requestId,
    });
    const prior = await client.query(
      `SELECT payload_fingerprint, result_entity_id, status
         FROM request_idempotency_ledger
        WHERE actor_type = 'parent' AND actor_id = $1
          AND operation = $2 AND normalized_request_id = $3
        FOR UPDATE`,
      [req.parent.id, CHECKOUT_ROUTE_OPERATION, requestId]
    );
    if (prior.rowCount) {
      const ledger = prior.rows[0];
      if (ledger.payload_fingerprint !== fingerprint) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '相同 request ID 已用於不同付款批次',
          code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        });
      }
      if (ledger.status !== 'completed' || !ledger.result_entity_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '此 request ID 正在處理，請稍後以相同內容重試',
          code: 'IDEMPOTENCY_IN_PROGRESS',
        });
      }
      const existing = await readCheckout(client, ledger.result_entity_id);
      if (!existing || !ownsCheckout(existing, req.parent)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '原始付款單不存在', code: 'IDEMPOTENCY_RESULT_MISSING' });
      }
      await client.query('COMMIT');
      const instruction = routeInstruction(
        existing.checkout_id,
        existing.payment_status,
        existing.payment_method
      );
      return res.json({
        status: 'success',
        ok: true,
        checkout_id: existing.checkout_id,
        idempotent: true,
        ...instruction,
        data: { ...instruction, total_amount: existing.total_amount },
        route_instruction: instruction,
      });
    }

    await client.query(
      `INSERT INTO request_idempotency_ledger
         (normalized_request_id, actor_type, actor_id, operation, payload_fingerprint, status)
       VALUES ($1, 'parent', $2, $3, $4, 'processing')`,
      [requestId, req.parent.id, CHECKOUT_ROUTE_OPERATION, fingerprint]
    );

    // 先鎖可能已存在的母單，再鎖子訂單，與 payment-proof route 的
    // checkout → enrollment 順序一致。
    const existingByBatch = await client.query(
      `SELECT checkout_id, enrollment_batch_id, payment_status, payment_method, order_kind
         FROM checkout_sessions
        WHERE parent_id = $1 AND enrollment_batch_id = $2
        FOR UPDATE`,
      [req.parent.id, batchId]
    );
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
    if (existingByBatch.rowCount && existingCheckoutIds.length
        && existingCheckoutIds[0] !== existingByBatch.rows[0].checkout_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '付款單與子訂單關聯不一致', code: 'CHECKOUT_LINK_CONFLICT' });
    }
    let verifiedProofUrl = first.payment_proof_url || null;
    if (!existingByBatch.rowCount && verifiedProofUrl) {
      const proofInput = await parseProofInput({ payment_proof_url: verifiedProofUrl });
      if (proofInput.error) {
        await client.query('ROLLBACK');
        return res.status(proofInput.status).json({ error: proofInput.error, code: proofInput.code });
      }
      verifiedProofUrl = proofInput.value;
    }
    const checkout = existingByBatch.rowCount
      ? {
          checkoutId: existingByBatch.rows[0].checkout_id,
          enrollmentBatchId: existingByBatch.rows[0].enrollment_batch_id,
          paymentStatus: existingByBatch.rows[0].payment_status,
          paymentMethod: existingByBatch.rows[0].payment_method || 'bank_transfer',
          orderKind: existingByBatch.rows[0].order_kind || 'standard',
          created: false,
        }
      : await createCheckoutSession(client, {
          parentId: req.parent.id,
          enrollmentBatchId: batchId,
          totalAmount,
          transferLast5: first.transfer_last_5 || null,
          paymentProofUrl: verifiedProofUrl,
          carrier: first.carrier || null,
          requestId,
          requestFingerprint: fingerprint,
          by: req.parent.phone,
          paymentMethod: first.payment_method || 'bank_transfer',
          orderKind: first.order_kind || 'standard',
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
    await client.query(
      `UPDATE request_idempotency_ledger
          SET result_entity_id = $4, status = 'completed', completed_at = NOW()
        WHERE actor_type = 'parent' AND actor_id = $1
          AND operation = $2 AND normalized_request_id = $3`,
      [req.parent.id, CHECKOUT_ROUTE_OPERATION, requestId, checkout.checkoutId]
    );
    const totalCheck = await client.query(
      `SELECT total_amount FROM checkout_sessions WHERE checkout_id = $1`,
      [checkout.checkoutId]
    );
    const checkoutTotalAmount = Number(totalCheck.rows[0]?.total_amount ?? totalAmount) || 0;
    await client.query('COMMIT');

    const instruction = routeInstruction(checkout.checkoutId, checkout.paymentStatus, checkout.paymentMethod);
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
    console.error('[checkout route]', { code: err?.code || 'UNEXPECTED' });
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

  const last5 = typeof req.body?.transfer_last_5 === 'string' ? req.body.transfer_last_5.trim() : '';
  const carrier = typeof req.body?.carrier === 'string' ? req.body.carrier.trim().slice(0, 64) : '';

  if (last5 && !/^\d{5}$/.test(last5)) {
    return res.status(400).json({ error: '轉帳末 5 碼需為 5 位數字', code: 'TRANSFER_LAST5_INVALID' });
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
    if (locked.rows[0].payment_method === 'on_site') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: '此訂單為現場付費，無需上傳轉帳證明',
        code: 'ON_SITE_PAYMENT_NO_TRANSFER_PROOF',
      });
    }
    if (![CHECKOUT_STATUS.PENDING_PAYMENT, CHECKOUT_STATUS.PENDING_RECONCILE].includes(locked.rows[0].payment_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此付款單狀態無法再上傳證明', code: 'NOT_PENDING' });
    }
    const proofInput = await parseProofInput(req.body, { allowClear: true });
    if (proofInput.error) {
      await client.query('ROLLBACK');
      return res.status(proofInput.status).json({ error: proofInput.error, code: proofInput.code });
    }
    const sameProof = proofInput.supplied && !proofInput.clear
      && proofInput.value === locked.rows[0].payment_proof_url;
    const sameLast5 = !last5 || last5 === locked.rows[0].transfer_last_5;
    if (locked.rows[0].transfer_last_5 && locked.rows[0].payment_proof_url
        && !proofInput.clear && !(sameProof && sameLast5)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '付款資料已送出，如需更改請聯繫櫃檯', code: 'PAYMENT_LOCKED' });
    }

    const nextLast5 = last5 || locked.rows[0].transfer_last_5 || null;
    const nextProofUrl = proofInput.clear
      ? null
      : proofInput.supplied ? proofInput.value : (locked.rows[0].payment_proof_url || null);
    const nextCarrier = carrier || locked.rows[0].carrier || null;
    if (!proofInput.clear && !nextProofUrl && !nextLast5 && !nextCarrier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '請填寫轉帳末 5 碼或上傳匯款／轉帳證明', code: 'PAYMENT_INFO_REQUIRED' });
    }

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
                jsonb_build_array(jsonb_build_object(
                  'at', NOW(),
                  'action', CASE WHEN $6 THEN 'payment_proof_cleared' ELSE 'payment_submitted' END,
                  'by', 'parent'
                )),
              updated_at = NOW()
        WHERE checkout_id = $1`,
      [checkoutId, nextLast5, nextProofUrl, nextCarrier, nextStatus, proofInput.clear]
    );
    await client.query(
      `UPDATE admin_enrollments
          SET transfer_last_5 = COALESCE($2, transfer_last_5),
              payment_proof_url = CASE
                WHEN $5 THEN NULL
                WHEN $6 THEN $3
                ELSE payment_proof_url
              END,
              carrier = COALESCE($4, carrier),
              updated_at = NOW()
        WHERE checkout_id = $1
          AND status = 'pending_payment'`,
      [checkoutId, last5 || null, proofInput.value, carrier || null, proofInput.clear, proofInput.supplied]
    );

    await client.query('COMMIT');
    res.json(await readCheckout(pool, checkoutId));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[checkout payment-proof]', { code: err?.code || 'UNEXPECTED' });
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
