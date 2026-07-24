const { randomUUID } = require('crypto');
const { normalizeRequestId } = require('./idempotency');
const { groupCheckoutFamilies } = require('./checkoutFamilies');

const CHECKOUT_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  PENDING_RECONCILE: 'pending_reconcile',
  PAID: 'paid',
  CANCELLED: 'cancelled',
};

function routeInstruction(checkoutId, state = CHECKOUT_STATUS.PENDING_PAYMENT, paymentMethod = 'bank_transfer') {
  const rawState = String(state || CHECKOUT_STATUS.PENDING_PAYMENT);
  const normalizedState = rawState.toUpperCase();
  return {
    current_state: normalizedState,
    checkout_id: checkoutId,
    payment_method: paymentMethod === 'on_site' ? 'on_site' : 'bank_transfer',
    target_page: '/checkout/payment-view',
    action_required: rawState.toLowerCase() === CHECKOUT_STATUS.PAID
      ? 'NONE'
      : paymentMethod === 'on_site' ? 'DISPLAY_ON_SITE_PAYMENT' : 'DISPLAY_BANK_INFO',
  };
}

function paymentStateFromProof({ transferLast5, paymentProofUrl, paymentMethod }) {
  if (paymentMethod === 'on_site') return CHECKOUT_STATUS.PENDING_PAYMENT;
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
  paymentMethod = 'bank_transfer',
  orderKind = 'standard',
  requestFingerprint = null,
} = {}) {
  const batchId = enrollmentBatchId || randomUUID();
  const normalizedRequestId = normalizeRequestId(requestId) || null;
  const normalizedPaymentMethod = paymentMethod === 'on_site' ? 'on_site' : 'bank_transfer';
  const normalizedOrderKind = orderKind === 'trial' ? 'trial' : 'standard';
  const paymentStatus = paymentStateFromProof({ transferLast5, paymentProofUrl, paymentMethod: normalizedPaymentMethod });
  const audit = [auditEntry('checkout_created', by, {
    enrollment_batch_id: batchId,
    payment_method: normalizedPaymentMethod,
    order_kind: normalizedOrderKind,
  })];

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
    normalizedPaymentMethod,
    normalizedOrderKind,
    requestFingerprint || null,
  ];

  let result;
  if (normalizedRequestId && parentId) {
    result = await client.query(
      `INSERT INTO checkout_sessions
         (parent_id, enrollment_batch_id, request_id, total_amount, payment_status,
          current_route_state, transfer_last_5, payment_proof_url, carrier, audit_log,
          payment_method, order_kind, request_payload_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
       ON CONFLICT (parent_id, request_id) WHERE request_id IS NOT NULL
       DO UPDATE SET updated_at = checkout_sessions.updated_at
       RETURNING checkout_id, enrollment_batch_id, payment_status, payment_method, order_kind, (xmax = 0) AS created`,
      args
    );
  } else if (parentId) {
    result = await client.query(
      `INSERT INTO checkout_sessions
         (parent_id, enrollment_batch_id, request_id, total_amount, payment_status,
          current_route_state, transfer_last_5, payment_proof_url, carrier, audit_log,
          payment_method, order_kind, request_payload_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
       ON CONFLICT (parent_id, enrollment_batch_id)
       WHERE parent_id IS NOT NULL AND enrollment_batch_id IS NOT NULL
       DO UPDATE SET updated_at = checkout_sessions.updated_at
       RETURNING checkout_id, enrollment_batch_id, payment_status, payment_method, order_kind, (xmax = 0) AS created`,
      args
    );
  } else {
    result = await client.query(
      `INSERT INTO checkout_sessions
         (parent_id, enrollment_batch_id, request_id, total_amount, payment_status,
          current_route_state, transfer_last_5, payment_proof_url, carrier, audit_log,
          payment_method, order_kind, request_payload_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
       ON CONFLICT (enrollment_batch_id)
       WHERE parent_id IS NULL AND enrollment_batch_id IS NOT NULL
       DO UPDATE SET updated_at = checkout_sessions.updated_at
       RETURNING checkout_id, enrollment_batch_id, payment_status, payment_method, order_kind, (xmax = 0) AS created`,
      args
    );
  }

  const row = result.rows[0];
  return {
    checkoutId: row.checkout_id,
    enrollmentBatchId: row.enrollment_batch_id,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method || 'bank_transfer',
    orderKind: row.order_kind || 'standard',
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
  const invoiceFamilies = groupCheckoutFamilies(subOrders);
  // 舊版家長端有一段時間只把匯款證明寫進 admin_enrollments，沒有同步到
  // checkout_sessions。F-M02 以 checkout 為單位讀取時，不能因此把仍存在的照片
  // 誤顯示成「未上傳」。母單欄位維持最高優先，並保留所有子訂單上的不同 URL，
  // 讓後台可逐張檢視；不在讀取時回寫或猜測任何孤兒檔案。
  const paymentProofUrls = [];
  const proofSeen = new Set();
  const ledgerProofUrls = parseJsonArray(row.uploaded_payment_proof_urls);
  const groupMemberProofUrls = parseJsonArray(row.group_member_payment_proof_urls);
  for (const candidate of [
    row.payment_proof_url,
    ...subOrders.map((order) => order.payment_proof_url),
    ...groupMemberProofUrls,
    ...ledgerProofUrls,
  ]) {
    const url = typeof candidate === 'string' ? candidate.trim() : '';
    if (!url || proofSeen.has(url)) continue;
    proofSeen.add(url);
    paymentProofUrls.push(url);
  }
  // 場館是 checkout 子訂單層級的資料；母單的第一筆 venue 僅為舊 API 相容欄位，
  // 不可當成整張 checkout 的唯一場館。由 API 的每筆子訂單名稱收斂為穩定陣列。
  const venueById = new Map();
  for (const order of subOrders) {
    const venueId = order.venue_id == null ? '' : String(order.venue_id);
    if (!venueId || venueById.has(venueId)) continue;
    venueById.set(venueId, {
      venue_id: venueId,
      venue_name: order.venue_name || venueId,
    });
  }
  const venues = [...venueById.values()].sort((a, b) => a.venue_id.localeCompare(b.venue_id));
  const fallbackVenueIds = parseJsonArray(row.venue_ids).map((id) => String(id)).filter(Boolean);
  return {
    checkout_id: row.checkout_id,
    parent_id: row.parent_id || null,
    enrollment_batch_id: row.enrollment_batch_id || null,
    request_id: row.request_id || null,
    parent_name: row.parent_name || first.parent_name || null,
    parent_phone: row.parent_phone || first.parent_phone || null,
    total_amount: Number(row.total_amount) || 0,
    payment_status: row.payment_status,
    payment_method: row.payment_method || 'bank_transfer',
    order_kind: row.order_kind || 'standard',
    current_route_state: row.current_route_state || row.payment_status,
    transfer_last_5: row.transfer_last_5 || '',
    carrier: row.carrier || '',
    parent_note: row.parent_note || '',
    payment_proof_url: paymentProofUrls[0] || null,
    payment_proof_urls: paymentProofUrls,
    has_payment_proof: paymentProofUrls.length > 0,
    submitted_at: row.submitted_at || row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    venue_ids: venues.length ? venues.map((venue) => venue.venue_id) : fallbackVenueIds,
    venues,
    order_count: Number(row.order_count) || subOrders.length,
    sub_orders: subOrders,
    invoice_families: invoiceFamilies,
    family_count: invoiceFamilies.length,
    requires_separate_invoices: invoiceFamilies.length > 1,
    venue: {
      id: row.venue_id || first.venue_id || null,
      name: row.venue_name || first.venue_name || row.venue_id || first.venue_id || null,
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
            COALESCE(av.name, v.name, first_ae.venue_id) AS venue_name,
            COALESCE(NULLIF(av.account_holder, ''), v.account_holder) AS account_holder,
            COALESCE(NULLIF(av.account_number, ''), v.account_number) AS account_number,
            COALESCE(NULLIF(av.bank_institution_name, ''), v.bank_institution_name) AS bank_institution_name,
            COALESCE(NULLIF(av.bank_branch_name, ''), v.bank_branch_name) AS bank_branch_name,
            MIN(ae.submitted_at) AS submitted_at,
            COUNT(ae.id)::int AS order_count,
            -- 團報家長的原始上傳來源在 group_order_members，不可只讀 checkout / enrollment。
            -- 以 group_order_id + canonical parent_id 精準歸戶；只有舊 checkout 缺 parent_id
            -- 時才用同一子訂單上的標準化家長電話補足，絕不以學生姓名或姓氏猜測。
            COALESCE((
              SELECT jsonb_agg(DISTINCT gom.payment_proof_url)
                FROM group_order_members gom
               WHERE NULLIF(gom.payment_proof_url, '') IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM admin_enrollments ae_group_member
                    WHERE ae_group_member.checkout_id = cs.checkout_id
                      AND ae_group_member.group_order_id = gom.group_order_id
                 )
                 AND (
                   gom.parent_id = cs.parent_id
                   OR (
                     cs.parent_id IS NULL
                     AND EXISTS (
                       SELECT 1
                         FROM parents gom_parent
                         JOIN admin_enrollments ae_group_phone
                           ON ae_group_phone.checkout_id = cs.checkout_id
                          AND regexp_replace(COALESCE(ae_group_phone.parent_phone, ''), '\\D', '', 'g') =
                              regexp_replace(COALESCE(gom_parent.phone, ''), '\\D', '', 'g')
                        WHERE gom_parent.id = gom.parent_id
                     )
                   )
                 )
            ), '[]'::jsonb) AS group_member_payment_proof_urls,
            -- 第一階段上傳 ledger：upload route 已在寫入時以 resolveOwnedTarget 驗證
            -- 上傳者擁有 target（母單家長、或子訂單上的家長／額外家長電話）。這裡的
            -- 歸戶條件必須涵蓋同一組規則——只認 cs.parent_id 會漏掉配偶等額外家長
            -- 合法上傳的照片，對帳清單就「讀不到」明明上傳成功的匯款證明。
            COALESCE((
              SELECT jsonb_agg(DISTINCT COALESCE(pu.preview_url, pu.original_url))
                FROM payment_proof_uploads pu
               WHERE (
                   pu.parent_id = cs.parent_id
                   OR EXISTS (
                     SELECT 1
                       FROM parents pu_parent
                       JOIN admin_enrollments ae_pu
                         ON ae_pu.checkout_id = cs.checkout_id
                      WHERE pu_parent.id = pu.parent_id
                        AND (
                          ae_pu.parent_phone = pu_parent.phone
                          OR pu_parent.phone = ANY(COALESCE(ae_pu.extra_parent_phones, '{}'))
                        )
                   )
                 )
                 AND (
                   (pu.target_type = 'checkout' AND pu.target_id = cs.checkout_id::text)
                   OR (pu.target_type = 'enrollment' AND EXISTS (
                     SELECT 1 FROM admin_enrollments ae_upload
                      WHERE ae_upload.checkout_id = cs.checkout_id
                        AND ae_upload.id = pu.target_id
                   ))
                   OR (pu.target_type = 'group_order' AND EXISTS (
                     SELECT 1 FROM admin_enrollments ae_group_upload
                      WHERE ae_group_upload.checkout_id = cs.checkout_id
                        AND ae_group_upload.group_order_id::text = pu.target_id
                   ))
                 )
            ), '[]'::jsonb) AS uploaded_payment_proof_urls,
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
                  'venue_name', COALESCE(ae_av.name, ae_v.name, ae.venue_id),
                  'course_type', ae.course_type,
                  'original_price', ae.original_price,
                  'final_price', ae.final_price,
                  'transfer_last_5', ae.transfer_last_5,
                  'payment_proof_url', ae.payment_proof_url,
                  -- 團報成員的電子發票載具存在 group_order_members.carrier，家長自助填寫
                  -- 的 my-proof 流程從不回寫 admin_enrollments.carrier；對帳（F-M02）
                  -- 家庭載具欄若只讀 ae.carrier 會空白（櫃檯得重刷）。以 group_order_id
                  -- ＋正規化家長電話對應成員載具補足；ae.carrier 有值（櫃檯手動填）優先。
                  'carrier', COALESCE(NULLIF(ae.carrier, ''), ae_gom_carrier.carrier),
                  'tax_id', ae.tax_id,
                  'payment_method', ae.payment_method,
                  'order_kind', ae.order_kind,
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
       LEFT JOIN venues ae_v ON ae_v.id = ae.venue_id
       LEFT JOIN admin_venues ae_av ON ae_av.id = ae.venue_id
       LEFT JOIN LATERAL (
         -- 對應此子訂單所屬團報成員的載具（同團 + 同一位家長電話）。
         SELECT gom.carrier
           FROM group_order_members gom
           JOIN parents gom_p ON gom_p.id = gom.parent_id
          WHERE gom.group_order_id = ae.group_order_id
            AND regexp_replace(COALESCE(gom_p.phone, ''), '\\D', '', 'g') =
                regexp_replace(COALESCE(ae.parent_phone, ''), '\\D', '', 'g')
            AND NULLIF(gom.carrier, '') IS NOT NULL
          ORDER BY gom.proof_uploaded_at DESC NULLS LAST
          LIMIT 1
       ) ae_gom_carrier ON ae.group_order_id IS NOT NULL
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
