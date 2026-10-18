const express = require('express');
const crypto = require('node:crypto');
const { pool } = require('../models/db');
const { readCheckout, CHECKOUT_STATUS } = require('../services/checkouts');
// Only a SHA-256 verifier is stored here; the scoped token stays on the summer server.
const { tokenSha256 } = require('../config/reconciliation-reader.json');
const pending = [CHECKOUT_STATUS.PENDING_PAYMENT, CHECKOUT_STATUS.PENDING_RECONCILE];
const router = express.Router();

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!/^[a-f0-9]{64}$/.test(tokenSha256 || '')) return res.status(503).json({ error: '對帳整合未設定' });
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const supplied = crypto.createHash('sha256').update(token).digest();
  if (!/^Bearer\s+\S+$/i.test(req.get('authorization') || '') || !crypto.timingSafeEqual(supplied, Buffer.from(tokenSha256, 'hex'))) {
    return res.status(401).json({ error: '對帳整合認證失敗' });
  }
  try {
    const result = await pool.query('SELECT checkout_id FROM checkout_sessions WHERE payment_status = ANY($1::text[]) ORDER BY created_at DESC', [pending]);
    const records = [];
    // Reuse checkout aggregation, including group and upload-ledger proof detection.
    for (let i = 0; i < result.rows.length; i += 8) {
      const checkouts = await Promise.all(result.rows.slice(i, i + 8).map(row => readCheckout(pool, row.checkout_id)));
      for (const checkout of checkouts) {
        if (!checkout || !pending.includes(checkout.payment_status)) continue;
        records.push({
          checkoutId: String(checkout.checkout_id),
          studentNames: [...new Set(checkout.sub_orders.flatMap(order => order.students))].join('、'),
          expectedAmount: checkout.total_amount, paymentStatus: checkout.payment_status,
          accountLastFive: checkout.transfer_last_5, hasPaymentProof: checkout.has_payment_proof,
          submittedAt: new Date(checkout.submitted_at).toISOString(), orderCount: checkout.order_count,
          venueNames: checkout.venues.map(venue => venue.venue_name).join('、'),
        });
      }
    }
    res.json({ generatedAt: new Date().toISOString(), records });
  } catch (error) {
    console.error('[reconciliation feed]', error.message);
    res.status(503).json({ error: '家教待對帳資料暫時無法讀取' });
  }
});

module.exports = router;
