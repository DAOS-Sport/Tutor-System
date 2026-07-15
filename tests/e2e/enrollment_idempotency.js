/*
 * Enrollment / checkout / trial idempotency integration test.
 * Uses isolated parent/student/order rows and removes them in finally.
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const { signToken: signAdminToken } = require('../../server/middlewares/adminAuth');
const enrollmentRouter = require('../../server/routes/enrollments');
const checkoutRouter = require('../../server/routes/checkout');
const adminEnrollmentRouter = require('../../server/routes/admin/enrollments');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/checkout', checkoutRouter);
  app.use('/api/admin/enrollments', adminEnrollmentRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'test route failure' }));
  const server = await new Promise((resolve) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function postAdmin(base, token, body, { headerKey = body?.request_id } = {}) {
  const response = await fetch(`${base}/api/admin/enrollments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(headerKey ? { 'Idempotency-Key': headerKey } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

async function postCheckoutRoute(base, token, body) {
  const response = await fetch(`${base}/api/checkout/route`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'Idempotency-Key': body.request_id,
    },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

async function post(base, token, body, { headerKey = body?.request_id } = {}) {
  const response = await fetch(`${base}/api/enrollments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(headerKey ? { 'Idempotency-Key': headerKey } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const parentId = randomUUID();
  const referrerId = randomUUID();
  const studentId = randomUUID();
  const phone = `09${String(parseInt(suffix.slice(0, 8), 16)).padStart(8, '0').slice(-8)}`;
  const referrerPhone = `08${String(parseInt(suffix.slice(2, 10), 16)).padStart(8, '0').slice(-8)}`;
  const referralToken = `e2e-${suffix}`;
  const triggerName = `e2e_enrollment_fail_${suffix}`;
  const functionName = `e2e_enrollment_fail_fn_${suffix}`;
  const carrierFailure = `E2E_FAIL_${suffix}`;
  let promotionId = null;
  let adminActorId = null;
  let adminRequestKey = null;
  let triggerInstalled = false;

  try {
    const reference = await pg.query(
      `SELECT c.id AS coach_id, v.id AS venue_id
         FROM coaches c CROSS JOIN venues v
        WHERE c.is_active = TRUE
          AND COALESCE(c.is_placeholder, FALSE) = FALSE
          AND v.is_active = TRUE
        ORDER BY c.created_at, v.id
        LIMIT 1`
    );
    if (!reference.rowCount) throw new Error('test database needs one active non-placeholder coach and venue');
    const { coach_id: coachId, venue_id: venueId } = reference.rows[0];
    const adminActor = (await pg.query(
      `SELECT id, username, name FROM admin_users WHERE is_active = TRUE ORDER BY created_at, id LIMIT 1`
    )).rows[0];
    if (!adminActor) throw new Error('test database needs one active admin user');
    adminActorId = adminActor.id;
    const autoPromotions = await pg.query(
      `SELECT id FROM promotions
        WHERE status = 'active' AND coupon_code IS NULL
          AND start_date <= NOW() AND end_date >= NOW()`
    );
    assert(autoPromotions.rowCount === 0, 'isolated test DB has no active automatic promotion that could mutate shared quota');
    const existingTrial50 = await pg.query(`SELECT id FROM promotions WHERE UPPER(coupon_code) = 'TRIAL50'`);
    assert(existingTrial50.rowCount === 0, 'isolated test DB has no pre-existing TRIAL50 configuration');

    await pg.query(
      `INSERT INTO parents (id, phone, name, is_active)
       VALUES ($1,$2,$3,TRUE),($4,$5,$6,TRUE)`,
      [parentId, phone, `E2E enrollment parent ${suffix}`, referrerId, referrerPhone, `E2E referrer ${suffix}`]
    );
    await pg.query(
      `INSERT INTO students (id, parent_id, name, is_active)
       VALUES ($1,$2,$3,TRUE)`,
      [studentId, parentId, `E2E student ${suffix}`]
    );
    const token = signParentToken({ parentId, phone });
    const basePayload = {
      coach: { id: coachId },
      venue: { id: venueId },
      course_type: 1,
      students: [{ id: studentId }],
      period_count: 1,
      order_kind: 'standard',
      payment_method: 'bank_transfer',
    };

    step('missing request ID fails before any write');
    const before = await pg.query(
      `SELECT COUNT(*)::int AS n FROM admin_enrollments WHERE parent_phone = $1`,
      [phone]
    );
    const missingKey = await post(route.base, token, basePayload, { headerKey: null });
    assert(missingKey.status === 400 && missingKey.data?.code === 'REQUEST_ID_REQUIRED', `missing key rejected (${missingKey.status})`);
    const after = await pg.query(
      `SELECT COUNT(*)::int AS n FROM admin_enrollments WHERE parent_phone = $1`,
      [phone]
    );
    assert(after.rows[0].n === before.rows[0].n, 'missing key created no enrollment/order rows');

    step('standard order persists six-session contract and retries return the original checkout');
    const normalKey = `e2e-normal-${suffix}`;
    const normalPayload = { ...basePayload, request_id: normalKey };
    const normal = await post(route.base, token, normalPayload);
    assert(normal.status === 201 && normal.data?.checkout_id, `standard enrollment created (${normal.status})`);
    const normalRetry = await post(route.base, token, normalPayload);
    assert(normalRetry.status === 200 && normalRetry.data?.idempotent === true, `same key retry is idempotent (${normalRetry.status})`);
    assert(normalRetry.data.checkout_id === normal.data.checkout_id, 'same key returns the same checkout');
    const normalDb = await pg.query(
      `SELECT COUNT(DISTINCT cs.checkout_id)::int AS checkout_count,
              COUNT(ae.id)::int AS order_count,
              MIN(ae.total_sessions)::int AS min_sessions,
              MAX(ae.total_sessions)::int AS max_sessions,
              MIN(ae.order_kind) AS order_kind
         FROM checkout_sessions cs
         JOIN admin_enrollments ae ON ae.checkout_id = cs.checkout_id
        WHERE cs.parent_id = $1 AND cs.request_id = $2`,
      [parentId, normalKey]
    );
    assert(normalDb.rows[0].checkout_count === 1 && normalDb.rows[0].order_count === 1, 'standard creates one checkout and one order');
    assert(normalDb.rows[0].min_sessions === 6 && normalDb.rows[0].max_sessions === 6 && normalDb.rows[0].order_kind === 'standard', 'standard order persists exactly six sessions');

    const mismatch = await post(route.base, token, {
      ...normalPayload,
      course_type: 2,
    });
    assert(mismatch.status === 409 && mismatch.data?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'same key with different payload returns 409');

    step('trial + on-site creates exactly one one-session order');
    const trialKey = `e2e-trial-${suffix}`;
    const trialPayload = {
      ...basePayload,
      request_id: trialKey,
      order_kind: 'trial',
      payment_method: 'on_site',
    };
    const trial = await post(route.base, token, trialPayload);
    assert(trial.status === 201 && trial.data?.payment_method === 'on_site', `trial/on-site created (${trial.status})`);
    const trialRetry = await post(route.base, token, trialPayload);
    assert(trialRetry.status === 200 && trialRetry.data?.checkout_id === trial.data.checkout_id, 'trial retry returns original checkout');
    const trialDb = await pg.query(
      `SELECT COUNT(DISTINCT cs.checkout_id)::int AS checkout_count,
              COUNT(ae.id)::int AS order_count,
              MIN(ae.total_sessions)::int AS sessions,
              MIN(ae.order_kind) AS order_kind,
              MIN(ae.payment_method) AS payment_method
         FROM checkout_sessions cs
         JOIN admin_enrollments ae ON ae.checkout_id = cs.checkout_id
        WHERE cs.parent_id = $1 AND cs.request_id = $2`,
      [parentId, trialKey]
    );
    assert(trialDb.rows[0].checkout_count === 1 && trialDb.rows[0].order_count === 1, 'trial creates one checkout and one order');
    assert(trialDb.rows[0].sessions === 1 && trialDb.rows[0].order_kind === 'trial' && trialDb.rows[0].payment_method === 'on_site', 'trial data remains one-session/on-site and does not inherit standard contract');

    step('success-page checkout routing refresh reuses the enrollment checkout');
    const routeKey = `checkout-route:${normal.data.batch_id}`;
    const routeBody = { enrollment_batch_id: normal.data.batch_id, request_id: routeKey };
    const routed = await postCheckoutRoute(route.base, token, routeBody);
    const routeRetry = await postCheckoutRoute(route.base, token, routeBody);
    assert(routed.status === 200 && routeRetry.status === 200, `checkout route first/retry both succeed (${routed.status}/${routeRetry.status})`);
    assert(routed.data?.checkout_id === normal.data.checkout_id && routeRetry.data?.checkout_id === normal.data.checkout_id,
      'checkout route refresh returns the original enrollment checkout');
    assert(routeRetry.data?.idempotent === true, 'checkout route retry is explicitly idempotent');
    const routeMismatch = await postCheckoutRoute(route.base, token, {
      enrollment_batch_id: trial.data.batch_id,
      request_id: routeKey,
    });
    assert(routeMismatch.status === 409 && routeMismatch.data?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'checkout route same key with another batch returns 409');
    const routedDb = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM checkout_sessions WHERE checkout_id = $1) AS checkouts,
         (SELECT COUNT(*)::int FROM admin_enrollments WHERE checkout_id = $1) AS orders,
         (SELECT COUNT(*)::int FROM request_idempotency_ledger
           WHERE actor_type = 'parent' AND actor_id = $2::text
             AND operation = 'route_checkout_session' AND normalized_request_id = $3) AS route_ledgers`,
      [normal.data.checkout_id, parentId, routeKey]
    );
    assert(routedDb.rows[0].checkouts === 1 && routedDb.rows[0].orders === 1 && routedDb.rows[0].route_ledgers === 1,
      'success-page refresh leaves one checkout, one order, and one route ledger');

    step('two concurrent requests with the same key serialize to one checkout/order');
    const concurrentKey = `e2e-concurrent-${suffix}`;
    const concurrentPayload = { ...basePayload, request_id: concurrentKey };
    const concurrent = await Promise.all([
      post(route.base, token, concurrentPayload),
      post(route.base, token, concurrentPayload),
    ]);
    assert(concurrent.map((result) => result.status).sort().join(',') === '200,201', `concurrent statuses are 201/200 (${concurrent.map((x) => x.status).join(',')})`);
    assert(concurrent[0].data.checkout_id === concurrent[1].data.checkout_id, 'concurrent calls return the same checkout');
    const concurrentDb = await pg.query(
      `SELECT COUNT(DISTINCT cs.checkout_id)::int AS checkout_count, COUNT(ae.id)::int AS order_count
         FROM checkout_sessions cs
         JOIN admin_enrollments ae ON ae.checkout_id = cs.checkout_id
        WHERE cs.parent_id = $1 AND cs.request_id = $2`,
      [parentId, concurrentKey]
    );
    assert(concurrentDb.rows[0].checkout_count === 1 && concurrentDb.rows[0].order_count === 1, 'concurrent DB result contains one checkout and one order');

    step('admin manual enrollment requires a key and shares the same pre-side-effect ledger contract');
    const adminToken = signAdminToken({
      sub: adminActor.id,
      username: adminActor.username,
      name: adminActor.name,
      role: 'admin',
      venue_ids: [],
    });
    const adminPayload = {
      parent_name: `E2E enrollment parent ${suffix}`,
      parent_phone: phone,
      students: [`E2E student ${suffix}`],
      venue_id: venueId,
      coach: 'E2E existing coach',
      coach_id: coachId,
      course_type: 1,
      total_sessions: 6,
      original_price: 6000,
      final_price: 6000,
      payment_method: '轉帳',
    };
    const adminBefore = await pg.query(`SELECT COUNT(*)::int AS n FROM admin_enrollments WHERE parent_phone = $1`, [phone]);
    const adminMissing = await postAdmin(route.base, adminToken, adminPayload, { headerKey: null });
    assert(adminMissing.status === 400 && adminMissing.data?.code === 'REQUEST_ID_REQUIRED', 'admin manual enrollment rejects a missing request ID');
    const adminAfterMissing = await pg.query(`SELECT COUNT(*)::int AS n FROM admin_enrollments WHERE parent_phone = $1`, [phone]);
    assert(adminAfterMissing.rows[0].n === adminBefore.rows[0].n, 'missing admin key creates no enrollment, checkout, or audit');

    adminRequestKey = `e2e-admin-${suffix}`;
    const adminBody = { ...adminPayload, request_id: adminRequestKey };
    const adminFirst = await postAdmin(route.base, adminToken, adminBody);
    const adminRetry = await postAdmin(route.base, adminToken, adminBody);
    assert(adminFirst.status === 201 && adminRetry.status === 200, `admin first/retry statuses are 201/200 (${adminFirst.status}/${adminRetry.status})`);
    assert(adminRetry.data?.idempotent === true && adminRetry.data?.checkout_id === adminFirst.data?.checkout_id, 'admin retry returns the original checkout');
    const adminMismatch = await postAdmin(route.base, adminToken, { ...adminBody, final_price: 5900 });
    assert(adminMismatch.status === 409 && adminMismatch.data?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'admin same key with changed price returns 409');
    const adminDb = await pg.query(
      `SELECT COUNT(DISTINCT cs.checkout_id)::int AS checkouts,
              COUNT(ae.id)::int AS orders,
              COUNT(al.id)::int AS audits,
              COUNT(DISTINCT ril.id)::int AS ledgers
         FROM checkout_sessions cs
         JOIN admin_enrollments ae ON ae.checkout_id = cs.checkout_id
         LEFT JOIN admin_enrollment_audit_logs al ON al.enrollment_id = ae.id
         LEFT JOIN request_idempotency_ledger ril
           ON ril.result_entity_id = cs.checkout_id::text
          AND ril.actor_type = 'admin' AND ril.actor_id = $2::text
          AND ril.operation = 'admin_create_enrollment_checkout'
        WHERE cs.checkout_id = $1
        GROUP BY cs.checkout_id`,
      [adminFirst.data.checkout_id, adminActor.id]
    );
    assert(adminDb.rows[0].checkouts === 1 && adminDb.rows[0].orders === 1 && adminDb.rows[0].audits === 1 && adminDb.rows[0].ledgers === 1,
      'admin retry leaves exactly one checkout, order, audit, and completed ledger');

    step('TRIAL50 referral and promotion side effects advance only once across retry');
    const promotion = await pg.query(
      `INSERT INTO promotions
         (name, description, type, discount_value, applicable_course_types, applicable_venue_ids,
          applicable_coach_multipliers, coupon_code, start_date, end_date, max_uses, status)
       VALUES ($1, 'isolated E2E only', 'PERCENTAGE', 0.5, ARRAY[1], ARRAY[$2]::varchar[],
               ARRAY[1.00]::numeric[], 'TRIAL50', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour', 10, 'active')
       RETURNING id`,
      [`E2E TRIAL50 ${suffix}`, venueId]
    );
    promotionId = promotion.rows[0].id;
    await pg.query(
      `INSERT INTO referral_records
         (token, referrer_parent_id, coach_id, referee_parent_id, referee_phone, status)
       VALUES ($1,$2,$3,$4,$5,'registered')`,
      [referralToken, referrerId, coachId, parentId, phone]
    );
    const referralKey = `e2e-referral-${suffix}`;
    const referralPayload = {
      ...basePayload,
      request_id: referralKey,
      promotion: { coupon_code: 'TRIAL50' },
    };
    const referralFirst = await post(route.base, token, referralPayload);
    assert(referralFirst.status === 201, `TRIAL50 first request created (${referralFirst.status})`);
    const referralRetry = await post(route.base, token, referralPayload);
    assert(referralRetry.status === 200 && referralRetry.data?.checkout_id === referralFirst.data.checkout_id, 'TRIAL50 retry returns original checkout');
    const sideEffects = await pg.query(
      `SELECT rr.status,
              (SELECT COUNT(*)::int FROM promotion_usages pu WHERE pu.promotion_id = $2 AND pu.parent_id = $1) AS usages,
              (SELECT current_uses FROM promotions WHERE id = $2) AS current_uses,
              (SELECT COUNT(*)::int FROM admin_enrollments ae WHERE ae.checkout_id = $3) AS orders,
              (SELECT COUNT(*)::int FROM admin_enrollment_audit_logs al
                WHERE al.enrollment_id IN (SELECT id FROM admin_enrollments WHERE checkout_id = $3)) AS audits
         FROM referral_records rr
        WHERE rr.token = $4`,
      [parentId, promotionId, referralFirst.data.checkout_id, referralToken]
    );
    assert(sideEffects.rows[0].status === 'trial_paid', 'referral advanced to trial_paid');
    assert(sideEffects.rows[0].usages === 1 && Number(sideEffects.rows[0].current_uses) === 1, 'promotion usage/current_uses advanced exactly once');
    assert(sideEffects.rows[0].orders === 1 && sideEffects.rows[0].audits === 1, 'retry created no second order or audit');

    step('forced failure after checkout insert rolls back checkout, order, audit, and ledger');
    await pg.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.carrier = '${carrierFailure}' THEN
           RAISE EXCEPTION 'intentional enrollment E2E failure';
         END IF;
         RETURN NEW;
       END $$`
    );
    await pg.query(
      `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON admin_enrollments
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
    );
    triggerInstalled = true;
    const failureKey = `e2e-failure-${suffix}`;
    const failed = await post(route.base, token, {
      ...basePayload,
      request_id: failureKey,
      carrier: carrierFailure,
    });
    assert(failed.status === 500, `intentional mid-transaction failure surfaces as 500 (${failed.status})`);
    const partials = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM checkout_sessions WHERE parent_id = $1 AND request_id = $2) AS checkouts,
         (SELECT COUNT(*)::int FROM request_idempotency_ledger
           WHERE actor_type = 'parent' AND actor_id = $1::text
             AND operation = 'create_enrollment_checkout' AND normalized_request_id = $2) AS ledgers,
         (SELECT COUNT(*)::int FROM admin_enrollments WHERE parent_phone = $3 AND carrier = $4) AS orders`,
      [parentId, failureKey, phone, carrierFailure]
    );
    assert(partials.rows[0].checkouts === 0 && partials.rows[0].ledgers === 0 && partials.rows[0].orders === 0, 'failed transaction leaves no checkout, successful ledger, or order half-product');
  } finally {
    if (triggerInstalled) await pg.query(`DROP TRIGGER IF EXISTS ${triggerName} ON admin_enrollments`).catch(() => {});
    await pg.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {});
    await pg.query(`DELETE FROM promotion_usages WHERE parent_id = $1`, [parentId]).catch(() => {});
    await pg.query(
      `DELETE FROM admin_enrollment_audit_logs
        WHERE enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = $1)`,
      [phone]
    ).catch(() => {});
    await pg.query(`DELETE FROM referral_records WHERE token = $1`, [referralToken]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE parent_phone = $1`, [phone]).catch(() => {});
    await pg.query(`DELETE FROM checkout_invoices WHERE checkout_id IN (SELECT checkout_id FROM checkout_sessions WHERE parent_id = $1)`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM request_idempotency_ledger WHERE actor_type = 'parent' AND actor_id = $1`, [parentId]).catch(() => {});
    if (adminActorId && adminRequestKey) {
      await pg.query(
        `DELETE FROM request_idempotency_ledger
          WHERE actor_type = 'admin' AND actor_id = $1 AND normalized_request_id = $2`,
        [adminActorId, adminRequestKey]
      ).catch(() => {});
    }
    await pg.query(`DELETE FROM checkout_sessions WHERE parent_id = $1`, [parentId]).catch(() => {});
    if (promotionId) await pg.query(`DELETE FROM promotions WHERE id = $1`, [promotionId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE id = $1`, [studentId]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [[parentId, referrerId]]).catch(() => {});
    await pg.end().catch(() => {});
    await route.close().catch(() => {});
  }

  step('enrollment idempotency cleanup complete');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
