const { randomUUID } = require('crypto');

const CHECKOUT_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  PENDING_RECONCILE: 'pending_reconcile',
  PAID: 'paid',
  CANCELLED: 'cancelled',
};

function normalizeRequestId(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  return s.slice(0, 128);
}

function routeInstruction(checkoutId, state = CHECKOUT_STATUS.PENDING_PAYMENT) {
  const rawState = String(state || CHECKOUT_STATUS.PENDING_PAYMENT);
  const normalizedState = rawState.toUpperCase();
  return {
    current_state: normalizedState,
    checkout_id: checkoutId,
    target_page: '/checkout/payment-view',
    action_required: rawState.toLowerCase() === CHECKOUT_STATUS.PAID ? 'NONE' : 'DISPLAY_BANK_INFO',
  };
}

function paymentStateFromProof({ transferLast5, paymentProofUrl }) {
  return transferLast5 || paymentProofUrl
    ? CHECKOUT_STATUS.PENDING_RECONCILE
    : CHECKOUT_STATUS.PENDING_PAYMENT;
}

function auditEntry(action, by = 'system', extra = {}) {
  return {
    at: new Date().toISOString(),
    action,
    by,
    ...extra,
  };
}

async function createCheckoutSession(client, {
  parentId = null,
  enrollmentBatchId,
  totalAmount,
  transferLast5 = null,
  paymentProofUrl = null,
  carrier = null,
  requestId = null,
  by = 'system',
} = {}) {
  const batchId = enrollmentBatchId || randomUUID();
  const normalizedRequestId = normalizeRequestId(requestId);
  const paymentStatus = paymentStateFromProof({ transferLast5, paymentProofUrl });
  const audit = [auditEntry('checkout_created', by, { enrollment_batch_id: batchId })];

  const args = [
    parentId || null,
    batchId,
    normalizedRequestId,
    Number(totalAmount) || 0,
    paymentStatus,
    paymentStatus,
    transferLast5 || null,
    paymentProofUrl || null,
    carrier || null,
    JSON.stringify(audit),
  ];

  let result;
  if (normalizedRequestId && parentId) {
    result = await client.query(
      `INSERT INTO checkout_sessions
         (parent_id, enrollment_batch_id, request_id, total_amount, payment_status,
          current_route_state, transfer_last_5, payment_proof_url, carrier, audit_log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (parent_id, request_id) WHERE request_id IS NOT NULL
       DO UPDATE SET updated_at = checkout_sessions.updated_at
       RETURNING checkout_id, enrollment_batch_id, payment_status, (xmax = 0) AS created`,
      args
    );
  } else if (parentId) {
    result = await client.query(
      `INSERT INTO checkout_sessions
         (parent_id, enrollment_batch_id, request_id, total_amount, payment_status,
          current_route_state, transfer_last_5, payment_proof_url, carrier, audit_log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (parent_id, enrollment_batch_id)
       WHERE parent_id IS NOT NULL AND enrollment_batch_id IS NOT NULL
       DO UPDATE SET updated_at = checkout_sessions.updated_at
       RETURNING checkout_id, enrollment_batch_id, payment_status, (xmax = 0) AS created`,
      args
    );
  } else {
    result = await client.query(
      `INSERT INTO checkout_sessions
         (parent_id, enrollment_batch_id, request_id, total_amount, payment_status,
          current_route_state, transfer_last_5, payment_proof_url, carrier, audit_log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (enrollment_batch_id)
       WHERE parent_id IS NULL AND enrollment_batch_id IS NOT NULL
       DO UPDATE SET updated_at = checkout_sessions.updated_at
       RETURNING checkout_id, enrollment_batch_id, payment_status, (xmax = 0) AS created`,
      args
    );
  }

  const row = result.rows[0];
  return {
    checkoutId: row.checkout_id,
    enrollmentBatchId: row.enrollment_batch_id,
    paymentStatus: row.payment_status,
    created: row.created === true || row.created === 't',
  };
}

async function attachBatchToCheckout(client, checkoutId, enrollmentBatchId, { parentPhone = null } = {}) {
  if (!checkoutId || !enrollmentBatchId) return 0;
  const r = await client.query(
    `UPDATE admin_enrollments
        SET checkout_id = $1,
            updated_at = NOW()
      WHERE enrollment_batch_id = $2
        AND ($3::text IS NULL OR parent_phone = $3)
        AND (checkout_id IS NULL OR checkout_id = $1)`,
    [checkoutId, enrollmentBatchId, parentPhone || null]
  );
  await refreshCheckoutTotal(client, checkoutId);
  return r.rowCount || 0;
}

async function refreshCheckoutTotal(client, checkoutId) {
  await client.query(
    `UPDATE checkout_sessions cs
        SET total_amount = COALESCE((
              SELECT SUM(ae.final_price)
                FROM admin_enrollments ae
               WHERE ae.checkout_id = cs.checkout_id
            ), cs.total_amount),
            updated_at = NOW()
      WHERE cs.checkout_id = $1`,
    [checkoutId]
  );
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shapeCheckout(row) {
  if (!row) return null;
  const subOrders = parseJsonArray(row.sub_orders).map((o) => ({
    ...o,
    original_price: Number(o.original_price) || 0,
    final_price: Number(o.final_price) || 0,
    period_count: Number(o.period_count) || 1,
    period_number: Number(o.period_number) || 1,
    total_sessions: o.total_sessions == null ? null : Number(o.total_sessions),
    used_sessions: o.used_sessions == null ? null : Number(o.used_sessions),
    students: Array.isArray(o.students) ? o.students : [],
    extra_parent_phones: Array.isArray(o.extra_parent_phones) ? o.extra_parent_phones : [],
  }));
  const first = subOrders[0] || {};
  return {
    checkout_id: row.checkout_id,
    parent_id: row.parent_id || null,
    enrollment_batch_id: row.enrollment_batch_id || null,
    request_id: row.request_id || null,
    parent_name: row.parent_name || first.parent_name || null,
    parent_phone: row.parent_phone || first.parent_phone || null,
    total_amount: Number(row.total_amount) || 0,
    payment_status: row.payment_status,
    current_route_state: row.current_route_state || row.payment_status,
    transfer_last_5: row.transfer_last_5 || '',
    carrier: row.carrier || '',
    payment_proof_url: row.payment_proof_url || null,
    has_payment_proof: !!row.payment_proof_url,
    submitted_at: row.submitted_at || row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    venue_ids: parseJsonArray(row.venue_ids),
    order_count: Number(row.order_count) || subOrders.length,
    sub_orders: subOrders,
    venue: {
      id: row.venue_id || first.venue_id || null,
      name: row.venue_name || row.venue_id || first.venue_id || null,
      account_holder: row.account_holder || null,
      account_number: row.account_number || null,
      bank_institution_name: row.bank_institution_name || null,
      bank_branch_name: row.bank_branch_name || null,
    },
  };
}

async function readCheckout(clientOrPool, checkoutId) {
  const r = await clientOrPool.query(
    `SELECT cs.*,
            p.name AS parent_name,
            p.phone AS parent_phone,
            first_ae.venue_id,
            v.name AS venue_name,
            COALESCE(NULLIF(av.account_holder, ''), v.account_holder) AS account_holder,
            COALESCE(NULLIF(av.account_number, ''), v.account_number) AS account_number,
            COALESCE(NULLIF(av.bank_institution_name, ''), v.bank_institution_name) AS bank_institution_name,
            COALESCE(NULLIF(av.bank_branch_name, ''), v.bank_branch_name) AS bank_branch_name,
            MIN(ae.submitted_at) AS submitted_at,
            COUNT(ae.id)::int AS order_count,
            COALESCE(jsonb_agg(DISTINCT to_jsonb(ae.venue_id)) FILTER (WHERE ae.venue_id IS NOT NULL), '[]'::jsonb) AS venue_ids,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id', ae.id,
                  'parent_name', ae.parent_name,
                  'parent_phone', ae.parent_phone,
                  'extra_parent_phones', ae.extra_parent_phones,
                  'students', ae.students,
                  'coach', ae.coach,
                  'coach_id', ae.coach_id,
                  'venue_id', ae.venue_id,
                  'course_type', ae.course_type,
                  'original_price', ae.original_price,
                  'final_price', ae.final_price,
                  'transfer_last_5', ae.transfer_last_5,
                  'payment_proof_url', ae.payment_proof_url,
                  'carrier', ae.carrier,
                  'status', ae.status,
                  'submitted_at', ae.submitted_at,
                  'total_sessions', ae.total_sessions,
                  'used_sessions', ae.used_sessions,
                  'group_order_id', ae.group_order_id,
                  'is_group_shared', ae.is_group_shared,
                  'period_count', ae.period_count,
                  'period_number', ae.period_number,
                  'checkout_id', ae.checkout_id
                )
                ORDER BY ae.submitted_at, ae.period_number, ae.id
              ) FILTER (WHERE ae.id IS NOT NULL),
              '[]'::jsonb
            ) AS sub_orders
       FROM checkout_sessions cs
       LEFT JOIN parents p ON p.id = cs.parent_id
       LEFT JOIN LATERAL (
         SELECT venue_id FROM admin_enrollments
          WHERE checkout_id = cs.checkout_id
          ORDER BY submitted_at, period_number, id
          LIMIT 1
       ) first_ae ON TRUE
       LEFT JOIN venues v ON v.id = first_ae.venue_id
       LEFT JOIN admin_venues av ON av.id = first_ae.venue_id
       LEFT JOIN admin_enrollments ae ON ae.checkout_id = cs.checkout_id
      WHERE cs.checkout_id = $1
      GROUP BY cs.checkout_id, p.id, first_ae.venue_id, v.id, av.id`,
    [checkoutId]
  );
  return shapeCheckout(r.rows[0]);
}

module.exports = {
  CHECKOUT_STATUS,
  normalizeRequestId,
  routeInstruction,
  createCheckoutSession,
  attachBatchToCheckout,
  refreshCheckoutTotal,
  readCheckout,
  shapeCheckout,
};
