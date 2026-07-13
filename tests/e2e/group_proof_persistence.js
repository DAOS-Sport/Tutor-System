/*
 * Payment-proof persistence integration test.
 * Exercises real local test storage existence plus enrollment/checkout/course/group routes.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID, randomBytes } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const { signToken: signAdminToken } = require('../../server/middlewares/adminAuth');
const enrollmentRouter = require('../../server/routes/enrollments');
const checkoutRouter = require('../../server/routes/checkout');
const coursesRouter = require('../../server/routes/courses');
const groupOrdersRouter = require('../../server/routes/groupOrders');
const adminGroupOrdersRouter = require('../../server/routes/admin/groupOrders');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/checkout', checkoutRouter);
  app.use('/api/courses', coursesRouter);
  app.use('/api/group-orders', groupOrdersRouter);
  app.use('/api/admin/group-orders', adminGroupOrdersRouter);
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

async function call(base, method, routePath, { token, body, requestId } = {}) {
  const response = await fetch(`${base}${routePath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(requestId ? { 'Idempotency-Key': requestId } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
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
  const parentA = randomUUID();
  const parentB = randomUUID();
  const studentA = randomUUID();
  const studentB = randomUUID();
  const phoneA = `09${String(parseInt(suffix.slice(0, 8), 16)).padStart(8, '0').slice(-8)}`;
  const phoneB = `07${String(parseInt(suffix.slice(2, 10), 16)).padStart(8, '0').slice(-8)}`;
  const groupOrderId = randomUUID();
  const checkoutId = randomUUID();
  const legacyRouteBatchId = randomUUID();
  const seededCheckoutEnrollment = `E2E-PROOF-CHECKOUT-${suffix}`;
  const courseEnrollment = `E2E-PROOF-COURSE-${suffix}`;
  const enrollmentIds = [seededCheckoutEnrollment, courseEnrollment];
  const checkoutIds = [checkoutId];
  let adminActorId = null;
  let adminApprovalKey = null;

  const month = '2026-07';
  const uploadDir = path.join(__dirname, '..', '..', 'server', 'uploads', month);
  const filenames = Array.from({ length: 5 }, () => `${randomBytes(12).toString('hex')}.jpg`);
  const proofUrls = filenames.map((name) => `/uploads/${month}/${name}`);
  const filePaths = filenames.map((name) => path.join(uploadDir, name));
  const missingUrl = `/uploads/${month}/${randomBytes(12).toString('hex')}.jpg`;

  try {
    await fs.promises.mkdir(uploadDir, { recursive: true });
    await Promise.all(filePaths.map((file) => fs.promises.writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))));

    const refs = await pg.query(
      `SELECT c.id AS coach_id, v.id AS venue_id
         FROM coaches c CROSS JOIN venues v
        WHERE c.is_active = TRUE
          AND COALESCE(c.is_placeholder, FALSE) = FALSE
          AND v.is_active = TRUE
        ORDER BY c.created_at, v.id LIMIT 1`
    );
    if (!refs.rowCount) throw new Error('test database needs active coach and venue');
    const { coach_id: coachId, venue_id: venueId } = refs.rows[0];
    const adminActor = (await pg.query(
      `SELECT id, username, name FROM admin_users WHERE is_active = TRUE ORDER BY created_at, id LIMIT 1`
    )).rows[0];
    if (!adminActor) throw new Error('test database needs one active admin user');
    adminActorId = adminActor.id;

    await pg.query(
      `INSERT INTO parents (id, phone, name, is_active, primary_venue_id)
       VALUES ($1,$2,$3,TRUE,$4),($5,$6,$7,TRUE,$4)`,
      [parentA, phoneA, `E2E proof leader ${suffix}`, venueId, parentB, phoneB, `E2E proof member ${suffix}`]
    );
    await pg.query(
      `INSERT INTO students (id, parent_id, name, is_active)
       VALUES ($1,$2,$3,TRUE),($4,$5,$6,TRUE)`,
      [studentA, parentA, `E2E proof student A ${suffix}`, studentB, parentB, `E2E proof student B ${suffix}`]
    );
    await pg.query(
      `INSERT INTO group_orders
         (id, leader_parent_id, venue_id, course_type, coach_id, status, join_token, min_students, max_students)
       VALUES ($1,$2,$3,2,$4,'forming',$5,2,2)`,
      [groupOrderId, parentA, venueId, coachId, `e2e-proof-${suffix}`]
    );
    await pg.query(
      `INSERT INTO group_order_members
         (group_order_id, parent_id, student_names, student_ids, payment_proof_url, is_leader, status)
       VALUES ($1,$2,$3,$4,NULL,TRUE,'joined'),
              ($1,$5,$6,$7,NULL,FALSE,'joined')`,
      [
        groupOrderId,
        parentA,
        [`E2E proof student A ${suffix}`],
        [studentA],
        parentB,
        [`E2E proof student B ${suffix}`],
        [studentB],
      ]
    );

    await pg.query(
      `INSERT INTO checkout_sessions
         (checkout_id, parent_id, enrollment_batch_id, total_amount, payment_status, current_route_state)
       VALUES ($1,$2,$3,1000,'pending_payment','pending_payment')`,
      [checkoutId, parentA, randomUUID()]
    );
    await pg.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
          original_price, final_price, status, submitted_at, checkout_id, payment_method,
          total_sessions, used_sessions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,1000,1000,'pending_payment',NOW(),$8,'bank_transfer',6,0),
              ($9,$2,$3,$4,$5,$6,$7,1,1000,1000,'pending_payment',NOW(),NULL,'bank_transfer',6,0)`,
      [
        seededCheckoutEnrollment,
        `E2E proof leader ${suffix}`,
        phoneA,
        [`E2E proof student A ${suffix}`],
        `E2E coach ${suffix}`,
        coachId,
        venueId,
        checkoutId,
        courseEnrollment,
      ]
    );

    const tokenA = signParentToken({ parentId: parentA, phone: phoneA });
    const tokenB = signParentToken({ parentId: parentB, phone: phoneB });

    step('enrollment route awaits real storage existence and fails closed for a missing object');
    const missingKey = `proof-missing-${suffix}`;
    const enrollmentBase = {
      coach: { id: coachId },
      venue: { id: venueId },
      course_type: 1,
      students: [{ id: studentA }],
      period_count: 1,
      order_kind: 'trial',
      payment_method: 'bank_transfer',
    };
    const missing = await call(route.base, 'POST', '/api/enrollments', {
      token: tokenA,
      requestId: missingKey,
      body: { ...enrollmentBase, request_id: missingKey, payment_proof_url: missingUrl },
    });
    assert(missing.status === 400 && missing.data?.code === 'PAYMENT_PROOF_INVALID', 'well-formed but nonexistent enrollment proof is rejected');
    const missingState = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM checkout_sessions WHERE parent_id = $1 AND request_id = $2) AS checkouts,
         (SELECT COUNT(*)::int FROM request_idempotency_ledger
           WHERE actor_id = $1::text AND normalized_request_id = $2) AS ledgers`,
      [parentA, missingKey]
    );
    assert(missingState.rows[0].checkouts === 0 && missingState.rows[0].ledgers === 0, 'failed proof lookup leaves no checkout or ledger half-product');

    const enrollmentKey = `proof-enrollment-${suffix}`;
    const enrollmentProof = await call(route.base, 'POST', '/api/enrollments', {
      token: tokenA,
      requestId: enrollmentKey,
      body: { ...enrollmentBase, request_id: enrollmentKey, payment_proof_url: proofUrls[0] },
    });
    assert(enrollmentProof.status === 201, `existing enrollment proof accepted (${enrollmentProof.status})`);
    checkoutIds.push(enrollmentProof.data.checkout_id);
    enrollmentIds.push(...(enrollmentProof.data.enrollment_ids || []));
    const enrollmentStored = await pg.query(
      `SELECT cs.payment_proof_url AS checkout_proof, ae.payment_proof_url AS order_proof
         FROM checkout_sessions cs JOIN admin_enrollments ae ON ae.checkout_id = cs.checkout_id
        WHERE cs.checkout_id = $1`,
      [enrollmentProof.data.checkout_id]
    );
    assert(enrollmentStored.rows[0].checkout_proof === proofUrls[0] && enrollmentStored.rows[0].order_proof === proofUrls[0], 'existing enrollment proof persists on checkout and order');

    step('same member concurrent proof/last5 updates retain both fields under row locks');
    const concurrent = await Promise.all([
      call(route.base, 'POST', `/api/group-orders/${groupOrderId}/my-proof`, {
        token: tokenA,
        body: { payment_proof_url: proofUrls[1] },
      }),
      call(route.base, 'POST', `/api/group-orders/${groupOrderId}/my-proof`, {
        token: tokenA,
        body: { transfer_last_5: '12345' },
      }),
    ]);
    assert(concurrent.every((result) => result.status === 200), `concurrent group updates both succeed (${concurrent.map((x) => x.status).join(',')})`);
    let groupState = await pg.query(
      `SELECT parent_id, payment_proof_url, transfer_last_5
         FROM group_order_members WHERE group_order_id = $1 ORDER BY parent_id`,
      [groupOrderId]
    );
    const leaderAfterConcurrent = groupState.rows.find((row) => row.parent_id === parentA);
    const memberAfterConcurrent = groupState.rows.find((row) => row.parent_id === parentB);
    assert(leaderAfterConcurrent.payment_proof_url === proofUrls[1] && leaderAfterConcurrent.transfer_last_5 === '12345', 'concurrent updates cause no lost proof or last5 update');
    assert(memberAfterConcurrent.payment_proof_url === null, 'leader update does not write another member row');

    step('omitted proof preserves existing value; member and individual proof updates stay isolated');
    const omitted = await call(route.base, 'POST', `/api/group-orders/${groupOrderId}/my-proof`, {
      token: tokenA,
      body: { transfer_last_5: '12345' },
    });
    assert(omitted.status === 200 && omitted.data?.idempotent === true, 'retry without a new proof is accepted idempotently');
    const memberUpdate = await call(route.base, 'POST', `/api/group-orders/${groupOrderId}/my-proof`, {
      token: tokenB,
      body: { payment_proof_url: proofUrls[2] },
    });
    assert(memberUpdate.status === 200, 'second member can upload own existing object');
    groupState = await pg.query(
      `SELECT parent_id, payment_proof_url FROM group_order_members WHERE group_order_id = $1`,
      [groupOrderId]
    );
    assert(groupState.rows.find((row) => row.parent_id === parentA).payment_proof_url === proofUrls[1], 'member update does not overwrite leader/group proof');
    assert(groupState.rows.find((row) => row.parent_id === parentB).payment_proof_url === proofUrls[2], 'member proof persists on the correct member row');

    const checkoutUpdate = await call(route.base, 'POST', `/api/checkout/${checkoutId}/payment-proof`, {
      token: tokenA,
      body: { payment_proof_url: proofUrls[3] },
    });
    assert(checkoutUpdate.status === 200, 'checkout proof route accepts a truly existing object');
    const isolatedAfterCheckout = await pg.query(
      `SELECT
         (SELECT payment_proof_url FROM checkout_sessions WHERE checkout_id = $1) AS checkout_proof,
         (SELECT payment_proof_url FROM group_order_members WHERE group_order_id = $2 AND parent_id = $3) AS leader_proof,
         (SELECT payment_proof_url FROM group_order_members WHERE group_order_id = $2 AND parent_id = $4) AS member_proof`,
      [checkoutId, groupOrderId, parentA, parentB]
    );
    assert(isolatedAfterCheckout.rows[0].checkout_proof === proofUrls[3], 'individual checkout proof updated');
    assert(isolatedAfterCheckout.rows[0].leader_proof === proofUrls[1] && isolatedAfterCheckout.rows[0].member_proof === proofUrls[2], 'checkout proof update does not overwrite group leader/member proofs');

    step('course proof route preserves omitted values and explicit delete affects only its own record');
    const courseUpdate = await call(route.base, 'POST', `/api/courses/${courseEnrollment}/payment-proof`, {
      token: tokenA,
      body: { payment_proof_url: proofUrls[4] },
    });
    assert(courseUpdate.status === 200, 'course proof route accepts existing object');
    const courseOmitted = await call(route.base, 'POST', `/api/courses/${courseEnrollment}/payment-proof`, {
      token: tokenA,
      body: { carrier: '/E2ETEST' },
    });
    assert(courseOmitted.status === 200, 'course update may omit a new proof');
    let courseState = await pg.query(`SELECT payment_proof_url FROM admin_enrollments WHERE id = $1`, [courseEnrollment]);
    assert(courseState.rows[0].payment_proof_url === proofUrls[4], 'omitted course proof preserves existing value');
    const courseClear = await call(route.base, 'POST', `/api/courses/${courseEnrollment}/payment-proof`, {
      token: tokenA,
      body: { delete_payment_proof: true },
    });
    assert(courseClear.status === 200, 'explicit course proof delete is accepted');
    courseState = await pg.query(`SELECT payment_proof_url FROM admin_enrollments WHERE id = $1`, [courseEnrollment]);
    assert(courseState.rows[0].payment_proof_url === null, 'explicit delete clears only the course proof');

    step('explicit group/member and checkout deletes never clear the other proof namespace');
    const leaderClear = await call(route.base, 'POST', `/api/group-orders/${groupOrderId}/my-proof`, {
      token: tokenA,
      body: { delete_payment_proof: true },
    });
    assert(leaderClear.status === 200, 'explicit leader/member proof delete succeeds');
    const afterLeaderClear = await pg.query(
      `SELECT
         (SELECT payment_proof_url FROM group_order_members WHERE group_order_id = $1 AND parent_id = $2) AS leader_proof,
         (SELECT payment_proof_url FROM group_order_members WHERE group_order_id = $1 AND parent_id = $3) AS member_proof,
         (SELECT payment_proof_url FROM checkout_sessions WHERE checkout_id = $4) AS checkout_proof`,
      [groupOrderId, parentA, parentB, checkoutId]
    );
    assert(afterLeaderClear.rows[0].leader_proof === null, 'explicit delete clears target leader/member row');
    assert(afterLeaderClear.rows[0].member_proof === proofUrls[2] && afterLeaderClear.rows[0].checkout_proof === proofUrls[3], 'deleting one group proof leaves other member and checkout proof untouched');

    const checkoutClear = await call(route.base, 'POST', `/api/checkout/${checkoutId}/payment-proof`, {
      token: tokenA,
      body: { delete_payment_proof: true },
    });
    assert(checkoutClear.status === 200, 'explicit checkout proof delete succeeds');
    const afterCheckoutClear = await pg.query(
      `SELECT
         (SELECT payment_proof_url FROM checkout_sessions WHERE checkout_id = $1) AS checkout_proof,
         (SELECT payment_proof_url FROM group_order_members WHERE group_order_id = $2 AND parent_id = $3) AS member_proof`,
      [checkoutId, groupOrderId, parentB]
    );
    assert(afterCheckoutClear.rows[0].checkout_proof === null && afterCheckoutClear.rows[0].member_proof === proofUrls[2], 'deleting checkout proof does not clear group member proof');

    step('legacy checkout routing refuses to copy a stored-but-missing proof into a new checkout');
    await pg.query(
      `UPDATE admin_enrollments
          SET enrollment_batch_id = $2, payment_proof_url = $3
        WHERE id = $1`,
      [courseEnrollment, legacyRouteBatchId, missingUrl]
    );
    const legacyRouteKey = `checkout-route:${legacyRouteBatchId}`;
    const legacyRoute = await call(route.base, 'POST', '/api/checkout/route', {
      token: tokenA,
      requestId: legacyRouteKey,
      body: { enrollment_batch_id: legacyRouteBatchId, request_id: legacyRouteKey },
    });
    assert(legacyRoute.status === 400 && legacyRoute.data?.code === 'PAYMENT_PROOF_INVALID', 'checkout routing fail-closes on a missing stored object');
    const legacyRouteState = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM checkout_sessions WHERE enrollment_batch_id = $1) AS checkouts,
         (SELECT COUNT(*)::int FROM request_idempotency_ledger
           WHERE actor_type = 'parent' AND actor_id = $2::text
             AND operation = 'route_checkout_session' AND normalized_request_id = $3) AS ledgers`,
      [legacyRouteBatchId, parentA, legacyRouteKey]
    );
    assert(legacyRouteState.rows[0].checkouts === 0 && legacyRouteState.rows[0].ledgers === 0, 'failed legacy route leaves no checkout or processing ledger');
    await pg.query(
      `UPDATE admin_enrollments SET enrollment_batch_id = NULL, payment_proof_url = NULL WHERE id = $1`,
      [courseEnrollment]
    );

    step('group approval checkout creation requires a request ID and retry returns the original orders');
    const leaderRestore = await call(route.base, 'POST', `/api/group-orders/${groupOrderId}/my-proof`, {
      token: tokenA,
      body: { payment_proof_url: proofUrls[1] },
    });
    assert(leaderRestore.status === 200, 'leader proof restored before approval');
    await pg.query(`UPDATE group_orders SET status = 'submitted', submitted_at = NOW() WHERE id = $1`, [groupOrderId]);
    const adminToken = signAdminToken({
      sub: adminActor.id,
      username: adminActor.username,
      name: adminActor.name,
      role: 'admin',
      venue_ids: [],
    });
    const approvalMissing = await call(route.base, 'POST', `/api/admin/group-orders/${groupOrderId}/approve`, {
      token: adminToken,
      body: {},
    });
    assert(approvalMissing.status === 400 && approvalMissing.data?.code === 'REQUEST_ID_REQUIRED', 'group approval rejects a missing request ID before order creation');
    const beforeApproval = await pg.query(`SELECT COUNT(*)::int AS n FROM admin_enrollments WHERE group_order_id = $1`, [groupOrderId]);
    assert(beforeApproval.rows[0].n === 0, 'missing group approval key creates no enrollment or checkout');

    adminApprovalKey = `group-approve:${groupOrderId}`;
    await fs.promises.rm(filePaths[2], { force: true });
    const missingAtApproval = await call(route.base, 'POST', `/api/admin/group-orders/${groupOrderId}/approve`, {
      token: adminToken,
      requestId: adminApprovalKey,
      body: { request_id: adminApprovalKey },
    });
    assert(missingAtApproval.status === 400 && missingAtApproval.data?.code === 'PAYMENT_PROOF_INVALID', 'group approval revalidates stored proof existence before copying it to checkout');
    const failedApprovalState = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM admin_enrollments WHERE group_order_id = $1) AS orders,
         (SELECT COUNT(*)::int FROM request_idempotency_ledger
           WHERE actor_type = 'admin' AND actor_id = $2::text
             AND operation = 'approve_group_order_checkouts' AND normalized_request_id = $3) AS ledgers`,
      [groupOrderId, adminActor.id, adminApprovalKey]
    );
    assert(failedApprovalState.rows[0].orders === 0 && failedApprovalState.rows[0].ledgers === 0, 'missing object approval rolls back orders and processing ledger');
    await fs.promises.writeFile(filePaths[2], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const approvals = await Promise.all([
      call(route.base, 'POST', `/api/admin/group-orders/${groupOrderId}/approve`, {
        token: adminToken,
        requestId: adminApprovalKey,
        body: { request_id: adminApprovalKey },
      }),
      call(route.base, 'POST', `/api/admin/group-orders/${groupOrderId}/approve`, {
        token: adminToken,
        requestId: adminApprovalKey,
        body: { request_id: adminApprovalKey },
      }),
    ]);
    assert(approvals.every((result) => result.status === 200), `concurrent group approval retries both return 200 (${approvals.map((x) => x.status).join(',')})`);
    assert(approvals.filter((result) => result.data?.idempotent === true).length === 1, 'one concurrent approval is explicitly returned as idempotent retry');
    const approvalIds = approvals[0].data.enrollment_ids || [];
    const approvalCheckoutIds = approvals[0].data.checkout_ids || [];
    assert(JSON.stringify(approvals[1].data.enrollment_ids) === JSON.stringify(approvalIds), 'group approval retry returns the original order IDs');
    enrollmentIds.push(...approvalIds);
    checkoutIds.push(...approvalCheckoutIds);
    const approvedState = await pg.query(
      `SELECT go.status,
              (SELECT COUNT(*)::int FROM admin_enrollments WHERE group_order_id = $1) AS orders,
              (SELECT COUNT(DISTINCT checkout_id)::int FROM admin_enrollments WHERE group_order_id = $1) AS checkouts,
              (SELECT COUNT(*)::int FROM admin_enrollment_audit_logs
                WHERE enrollment_id IN (SELECT id FROM admin_enrollments WHERE group_order_id = $1)) AS audits,
              (SELECT COUNT(*)::int FROM request_idempotency_ledger
                WHERE actor_type = 'admin' AND actor_id = $2::text
                  AND operation = 'approve_group_order_checkouts'
                  AND normalized_request_id = $3 AND status = 'completed') AS ledgers
         FROM group_orders go WHERE go.id = $1`,
      [groupOrderId, adminActor.id, adminApprovalKey]
    );
    assert(approvedState.rows[0].status === 'approved', 'group moves to approved exactly once');
    assert(approvedState.rows[0].orders === 2 && approvedState.rows[0].checkouts === 2, 'two families produce exactly two orders and two checkouts');
    assert(approvedState.rows[0].audits === 2 && approvedState.rows[0].ledgers === 1, 'concurrent retry creates no duplicate audit or ledger');
  } finally {
    await pg.query(`DELETE FROM promotion_usages WHERE parent_id = ANY($1::uuid[])`, [[parentA, parentB]]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    await pg.query(`DELETE FROM request_idempotency_ledger WHERE actor_type = 'parent' AND actor_id = ANY($1::text[])`, [[parentA, parentB]]).catch(() => {});
    if (adminActorId && adminApprovalKey) {
      await pg.query(
        `DELETE FROM request_idempotency_ledger
          WHERE actor_type = 'admin' AND actor_id = $1 AND normalized_request_id = $2`,
        [adminActorId, adminApprovalKey]
      ).catch(() => {});
    }
    await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[]) OR parent_phone IN ($2,$3)`, [enrollmentIds, phoneA, phoneB]).catch(() => {});
    await pg.query(`DELETE FROM checkout_invoices WHERE checkout_id = ANY($1::uuid[])`, [checkoutIds]).catch(() => {});
    await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::uuid[]) OR parent_id = ANY($2::uuid[])`, [checkoutIds, [parentA, parentB]]).catch(() => {});
    await pg.query(`DELETE FROM group_orders WHERE id = $1`, [groupOrderId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE id = ANY($1::uuid[])`, [[studentA, studentB]]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [[parentA, parentB]]).catch(() => {});
    await Promise.all(filePaths.map((file) => fs.promises.rm(file, { force: true }).catch(() => {})));
    await pg.end().catch(() => {});
    await route.close().catch(() => {});
  }

  step('group proof persistence cleanup complete');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
