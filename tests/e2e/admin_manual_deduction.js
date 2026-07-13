/*
 * Manual deduction integration/concurrency test.
 * Real routes + real PostgreSQL, isolated rows only, cleanup in finally.
 */
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signToken } = require('../../server/middlewares/adminAuth');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const manualRouter = require('../../server/routes/admin/manualDeductions');
const slotsRouter = require('../../server/routes/slots');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin/manual-deductions', manualRouter);
  app.use('/api/slots', slotsRouter);
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

async function call(base, method, path, { token, body, requestId } = {}) {
  const response = await fetch(`${base}${path}`, {
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
  const parentId = randomUUID();
  const studentId = randomUUID();
  const secondStudentId = randomUUID();
  const phone = `09${String(parseInt(suffix.slice(0, 8), 16)).padStart(8, '0').slice(-8)}`;
  const periods = [];
  const enrollmentIds = [];
  const slotIds = [];
  const triggerName = `e2e_manual_fail_${suffix}`;
  const functionName = `e2e_manual_fail_fn_${suffix}`;
  const forcedReason = `E2E_FORCE_FAIL_${suffix}`;
  let triggerInstalled = false;

  try {
    const refs = await pg.query(
      `SELECT c.id AS coach_id,
              (SELECT id FROM venues WHERE is_active = TRUE ORDER BY id LIMIT 1) AS venue_a,
              (SELECT id FROM venues WHERE is_active = TRUE ORDER BY id OFFSET 1 LIMIT 1) AS venue_b
         FROM coaches c
        WHERE c.is_active = TRUE AND COALESCE(c.is_placeholder, FALSE) = FALSE
        ORDER BY c.created_at
        LIMIT 1`
    );
    if (!refs.rowCount || !refs.rows[0].venue_a || !refs.rows[0].venue_b) {
      throw new Error('test database needs one active coach and two active venues');
    }
    const { coach_id: coachId, venue_a: venueA, venue_b: venueB } = refs.rows[0];
    await pg.query(
      `INSERT INTO parents (id, phone, name, is_active, primary_venue_id)
       VALUES ($1,$2,$3,TRUE,$4)`,
      [parentId, phone, `E2E manual parent ${suffix}`, venueA]
    );
    await pg.query(
      `INSERT INTO students (id, parent_id, name, is_active)
       VALUES ($1,$2,$3,TRUE),($4,$2,$5,TRUE)`,
      [studentId, parentId, `E2E manual student ${suffix}`, secondStudentId, `E2E shared student ${suffix}`]
    );

    async function addPeriod(label, {
      total = 1,
      venue = venueA,
      members = [studentId],
      groupOrderId = null,
      reserved = 0,
    } = {}) {
      const enrollmentId = `E2E-MD-${suffix}-${label}`;
      const periodId = randomUUID();
      enrollmentIds.push(enrollmentId);
      periods.push(periodId);
      await pg.query(
        `INSERT INTO admin_enrollments
           (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
            original_price, final_price, status, submitted_at, total_sessions, used_sessions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,1000,1000,'confirmed',NOW(),$8,0)`,
        [enrollmentId, `E2E parent ${suffix}`, phone, members.map((id) => (
          id === studentId ? `E2E manual student ${suffix}` : `E2E shared student ${suffix}`
        )), `E2E coach ${suffix}`, coachId, venue, total]
      );
      await pg.query(
        `INSERT INTO course_periods
           (id, coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at,
            original_price, final_price, status, admin_enrollment_id, group_order_id)
         VALUES ($1,$2,$3,1,$4,0,CURRENT_DATE + 90,1000,1000,'active',$5,$6)`,
        [periodId, coachId, venue, total, enrollmentId, groupOrderId]
      );
      for (const memberId of members) {
        await pg.query(
          `INSERT INTO course_period_enrollments (course_period_id, student_id, status)
           VALUES ($1,$2,'active')`,
          [periodId, memberId]
        );
      }
      for (let i = 0; i < reserved; i += 1) {
        await pg.query(
          `INSERT INTO course_sessions
             (course_period_id, coach_id, scheduled_at, duration_minutes, status)
           VALUES ($1,$2,NOW() + (($3 + 1) || ' days')::interval,60,'confirmed')`,
          [periodId, coachId, i]
        );
      }
      return { periodId, enrollmentId };
    }

    const success = await addPeriod('success', { total: 2 });
    const reserved = await addPeriod('reserved', { total: 1, reserved: 1 });
    const shared = await addPeriod('shared', { total: 2, members: [studentId, secondStudentId] });
    const outOfScope = await addPeriod('outscope', { total: 1, venue: venueB });
    const adminCrossVenue = await addPeriod('admin-cross', { total: 1, venue: venueB });
    const concurrentManual = await addPeriod('concurrent', { total: 1 });
    const slotRace = await addPeriod('slot-race', { total: 1 });
    const forcedFailure = await addPeriod('forced-failure', { total: 1 });

    const staffToken = signToken({
      sub: `e2e-staff-${suffix}`,
      username: `e2e-staff-${suffix}`,
      name: `E2E Staff ${suffix}`,
      role: 'staff',
      venue_id: venueA,
      venue_ids: [venueA],
    });
    const managerToken = signToken({
      sub: `e2e-manager-${suffix}`,
      username: `e2e-manager-${suffix}`,
      name: `E2E Manager ${suffix}`,
      role: 'manager',
      venue_id: venueA,
      venue_ids: [venueA],
    });
    const adminToken = signToken({
      sub: `e2e-admin-${suffix}`,
      username: `e2e-admin-${suffix}`,
      name: `E2E Admin ${suffix}`,
      role: 'admin',
      venue_id: null,
      venue_ids: [],
    });
    const nonBackofficeToken = signToken({
      sub: `e2e-coach-${suffix}`,
      username: `e2e-coach-${suffix}`,
      name: `E2E Coach ${suffix}`,
      role: 'coach',
      venue_id: venueA,
      venue_ids: [venueA],
    });
    const parentToken = signParentToken({ parentId, phone });

    step('manual deduction authentication, route, and sidebar role contract');
    const root = path.join(__dirname, '..', '..');
    const appSource = fs.readFileSync(path.join(root, 'client/admin/src/App.jsx'), 'utf8');
    const sidebarSource = fs.readFileSync(path.join(root, 'client/admin/src/components/Sidebar.jsx'), 'utf8');
    const adminRouteSource = fs.readFileSync(path.join(root, 'server/routes/admin.js'), 'utf8');
    assert(appSource.includes("path=\"/manual-deduction\"")
      && appSource.includes("roles={['admin', 'manager', 'staff']}"), 'client route allows exactly the backoffice roles supported by the API');
    assert(sidebarSource.includes("to: '/manual-deduction'")
      && sidebarSource.includes("roles: ['admin', 'manager', 'staff']"), 'sidebar exposes manual deduction to the same three roles');
    assert(adminRouteSource.includes("router.use('/manual-deductions'"), 'admin API router mounts the manual-deductions endpoint');
    const anonymous = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      body: { course_period_id: success.periodId, student_id: studentId, reason: 'anonymous', request_id: `anon-${suffix}` },
    });
    assert(anonymous.status === 401, `anonymous rejected (${anonymous.status})`);
    const nonBackoffice = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: nonBackofficeToken,
      body: { course_period_id: success.periodId, student_id: studentId, reason: 'coach', request_id: `coach-${suffix}` },
    });
    assert(nonBackoffice.status === 403, `non-backoffice role rejected (${nonBackoffice.status})`);

    const missingKey = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: staffToken,
      body: { course_period_id: success.periodId, student_id: studentId, reason: 'missing key' },
    });
    assert(missingKey.status === 400 && missingKey.data?.code === 'REQUEST_ID_REQUIRED', 'missing request ID is rejected before deduction');

    const managerList = await call(route.base, 'GET', `/api/admin/manual-deductions?search=${encodeURIComponent(suffix)}`, { token: managerToken });
    assert(managerList.status === 200, 'manager reaches manual deduction API under shared auth rules');

    step('authorized staff deduction creates authoritative session/check-in/ledger/audit exactly once');
    const successKey = `e2e-success-${suffix}`;
    const successBody = {
      course_period_id: success.periodId,
      student_id: studentId,
      reason: `E2E approved deduction ${suffix}`,
      request_id: successKey,
    };
    const created = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: staffToken,
      requestId: successKey,
      body: successBody,
    });
    assert(created.status === 201 && created.data?.deduction, `authorized staff succeeds (${created.status})`);
    assert(created.data.deduction.remaining_before === 2 && created.data.deduction.remaining_after === 1, 'remaining sessions decrease from 2 to 1');
    const persisted = await pg.query(
      `SELECT d.course_period_id, d.student_id, d.venue_id, d.reason, d.deducted_by,
              d.remaining_before, d.remaining_after, d.payload_fingerprint,
              cs.status::text AS session_status,
              cr.student_id AS checkin_student_id,
              cr.checked_in_by_student_id,
              cr.checked_in_source,
              cp.used_sessions AS period_used,
              ae.used_sessions AS enrollment_used,
              al.by_user AS audit_actor,
              al.reason AS audit_reason,
              al.action AS audit_action
         FROM manual_lesson_deductions d
         JOIN course_sessions cs ON cs.id = d.course_session_id
         JOIN checkin_records cr ON cr.course_session_id = cs.id AND cr.student_id = d.student_id
         JOIN course_periods cp ON cp.id = d.course_period_id
         JOIN admin_enrollments ae ON ae.id = d.admin_enrollment_id
         LEFT JOIN LATERAL (
           SELECT by_user, reason, action FROM admin_enrollment_audit_logs
            WHERE enrollment_id = ae.id ORDER BY id DESC LIMIT 1
         ) al ON TRUE
        WHERE d.course_period_id = $1 AND d.request_id = $2`,
      [success.periodId, successKey]
    );
    const row = persisted.rows[0];
    assert(row.course_period_id === success.periodId && row.student_id === studentId && row.venue_id === venueA, 'ledger links exact course, student, and venue');
    assert(row.reason === successBody.reason && row.deducted_by === `E2E Staff ${suffix}`, 'reason and actor come from trusted request/token');
    assert(row.session_status === 'completed' && row.checkin_student_id === studentId && row.checked_in_by_student_id === studentId && row.checked_in_source === 'staff', 'completed session and legacy-compatible check-in are persisted');
    assert(Number(row.period_used) === 1 && Number(row.enrollment_used) === 1, 'legacy display counters match authoritative attended count');
    assert(row.audit_actor === `E2E Staff ${suffix}` && row.audit_reason === successBody.reason && /手動扣課 1 堂/.test(row.audit_action || ''), 'append-only enrollment audit has actor, reason, and action');
    assert(/^[a-f0-9]{64}$/.test(row.payload_fingerprint || ''), 'manual ledger stores payload fingerprint');

    const retry = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: staffToken,
      requestId: successKey,
      body: successBody,
    });
    assert(retry.status === 200 && retry.data?.idempotent === true && retry.data.deduction.id === created.data.deduction.id, 'same request ID returns the same deduction');
    const mismatch = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: staffToken,
      requestId: successKey,
      body: { ...successBody, reason: `${successBody.reason} changed` },
    });
    assert(mismatch.status === 409 && mismatch.data?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'same request ID with different payload returns 409');
    const exactlyOnce = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM manual_lesson_deductions WHERE course_period_id = $1) AS ledgers,
         (SELECT COUNT(*)::int FROM course_sessions WHERE course_period_id = $1) AS sessions,
         (SELECT COUNT(*)::int FROM checkin_records cr JOIN course_sessions cs ON cs.id = cr.course_session_id WHERE cs.course_period_id = $1) AS checkins`,
      [success.periodId]
    );
    assert(exactlyOnce.rows[0].ledgers === 1 && exactlyOnce.rows[0].sessions === 1 && exactlyOnce.rows[0].checkins === 1, 'retry/mismatch create no duplicate ledger, session, or check-in');

    step('venue scope, manager capacity, shared-period, and admin rules fail closed as designed');
    const foreign = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: staffToken,
      body: { course_period_id: outOfScope.periodId, student_id: studentId, reason: 'foreign venue', request_id: `foreign-${suffix}` },
    });
    assert(foreign.status === 403 && foreign.data?.code === 'VENUE_OUT_OF_SCOPE', `out-of-scope venue rejected (${foreign.status})`);

    const insufficient = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: managerToken,
      body: { course_period_id: reserved.periodId, student_id: studentId, reason: 'fully reserved', request_id: `reserved-${suffix}` },
    });
    assert(insufficient.status === 409 && insufficient.data?.code === 'INSUFFICIENT_SESSIONS', 'fully reserved but unchecked period cannot be overbooked');
    const reservedState = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM manual_lesson_deductions WHERE course_period_id = $1) AS ledgers,
         (SELECT COUNT(*)::int FROM checkin_records cr JOIN course_sessions cs ON cs.id = cr.course_session_id WHERE cs.course_period_id = $1) AS checkins`,
      [reserved.periodId]
    );
    assert(reservedState.rows[0].ledgers === 0 && reservedState.rows[0].checkins === 0, 'insufficient transaction leaves no ledger/check-in half-product');

    const sharedResult = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: staffToken,
      body: { course_period_id: shared.periodId, student_id: studentId, reason: 'shared period', request_id: `shared-${suffix}` },
    });
    assert(sharedResult.status === 409 && sharedResult.data?.code === 'SHARED_PERIOD_REQUIRES_CHECKIN', 'shared/group period fails closed');
    const sharedState = await pg.query(`SELECT COUNT(*)::int AS n FROM course_sessions WHERE course_period_id = $1`, [shared.periodId]);
    assert(sharedState.rows[0].n === 0, 'shared-period rejection creates no personal session');

    const adminKey = `admin-cross-${suffix}`;
    const adminResult = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: adminToken,
      body: { course_period_id: adminCrossVenue.periodId, student_id: studentId, reason: 'admin cross venue', request_id: adminKey },
    });
    assert(adminResult.status === 201, `admin follows existing all-venue rule (${adminResult.status})`);

    step('concurrent manual deductions cannot occupy the same remaining capacity twice');
    const manualBodies = [1, 2].map((n) => ({
      course_period_id: concurrentManual.periodId,
      student_id: studentId,
      reason: `concurrent manual ${n}`,
      request_id: `manual-concurrent-${n}-${suffix}`,
    }));
    const concurrentResults = await Promise.all(manualBodies.map((body) => call(
      route.base,
      'POST',
      '/api/admin/manual-deductions',
      { token: staffToken, body, requestId: body.request_id }
    )));
    assert(concurrentResults.map((result) => result.status).sort().join(',') === '201,409', `concurrent manual statuses are 201/409 (${concurrentResults.map((x) => x.status).join(',')})`);
    const concurrentCount = await pg.query(
      `SELECT COUNT(*)::int AS sessions FROM course_sessions
        WHERE course_period_id = $1 AND status::text NOT LIKE 'cancelled%'`,
      [concurrentManual.periodId]
    );
    assert(concurrentCount.rows[0].sessions === 1, 'concurrent manual deductions reserve only one session');

    step('slot booking and manual deduction use the same coach lock and cannot oversell');
    const slotId = randomUUID();
    slotIds.push(slotId);
    await pg.query(
      `INSERT INTO coach_availability_slots
         (id, coach_id, venue_id, start_at, duration_minutes, status, notes)
       VALUES ($1,$2,$3,NOW() + INTERVAL '180 days' + ($4 || ' seconds')::interval,60,'available',$5)`,
      [slotId, coachId, venueA, parseInt(suffix.slice(0, 5), 16), `E2E slot ${suffix}`]
    );
    const slotManualBody = {
      course_period_id: slotRace.periodId,
      student_id: studentId,
      reason: `slot race ${suffix}`,
      request_id: `slot-race-${suffix}`,
    };
    const [manualRace, slotBooking] = await Promise.all([
      call(route.base, 'POST', '/api/admin/manual-deductions', {
        token: staffToken,
        body: slotManualBody,
        requestId: slotManualBody.request_id,
      }),
      call(route.base, 'POST', `/api/slots/${slotId}/book`, {
        token: parentToken,
        body: { course_period_id: slotRace.periodId },
      }),
    ]);
    assert([manualRace.status, slotBooking.status].filter((status) => status === 201).length === 1, `slot/manual race has exactly one success (${manualRace.status}/${slotBooking.status})`);
    assert([manualRace.status, slotBooking.status].filter((status) => status === 409).length === 1, 'losing slot/manual request receives capacity conflict');
    const raceCount = await pg.query(
      `SELECT COUNT(*)::int AS sessions FROM course_sessions
        WHERE course_period_id = $1 AND status::text NOT LIKE 'cancelled%'`,
      [slotRace.periodId]
    );
    assert(raceCount.rows[0].sessions === 1, 'slot/manual race leaves exactly one reserved session');

    step('forced database failure after session/check-in creation rolls back the complete transaction');
    await pg.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.reason = '${forcedReason}' THEN
           RAISE EXCEPTION 'intentional manual deduction E2E failure';
         END IF;
         RETURN NEW;
       END $$`
    );
    await pg.query(
      `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON manual_lesson_deductions
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
    );
    triggerInstalled = true;
    const failureKey = `forced-failure-${suffix}`;
    const failed = await call(route.base, 'POST', '/api/admin/manual-deductions', {
      token: staffToken,
      body: {
        course_period_id: forcedFailure.periodId,
        student_id: studentId,
        reason: forcedReason,
        request_id: failureKey,
      },
    });
    assert(failed.status === 500 && failed.data?.code === 'MANUAL_DEDUCTION_FAILED', `forced failure returns rollback-safe 500 (${failed.status})`);
    const failedState = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM manual_lesson_deductions WHERE course_period_id = $1) AS ledgers,
         (SELECT COUNT(*)::int FROM course_sessions WHERE course_period_id = $1) AS sessions,
         (SELECT COUNT(*)::int FROM checkin_records cr JOIN course_sessions cs ON cs.id = cr.course_session_id WHERE cs.course_period_id = $1) AS checkins,
         (SELECT COUNT(*)::int FROM admin_enrollment_audit_logs WHERE enrollment_id = $2) AS audits`,
      [forcedFailure.periodId, forcedFailure.enrollmentId]
    );
    assert(failedState.rows[0].ledgers === 0 && failedState.rows[0].sessions === 0 && failedState.rows[0].checkins === 0 && failedState.rows[0].audits === 0, 'forced failure leaves no ledger/session/check-in/audit half-product');
  } finally {
    if (triggerInstalled) await pg.query(`DROP TRIGGER IF EXISTS ${triggerName} ON manual_lesson_deductions`).catch(() => {});
    await pg.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    await pg.query(`DELETE FROM manual_lesson_deductions WHERE course_period_id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pg.query(
      `DELETE FROM checkin_records
        WHERE course_session_id IN (SELECT id FROM course_sessions WHERE course_period_id = ANY($1::uuid[]))`,
      [periods]
    ).catch(() => {});
    if (slotIds.length) {
      await pg.query(`UPDATE coach_availability_slots SET booked_session_id = NULL WHERE id = ANY($1::uuid[])`, [slotIds]).catch(() => {});
      await pg.query(`UPDATE course_sessions SET availability_slot_id = NULL WHERE availability_slot_id = ANY($1::uuid[])`, [slotIds]).catch(() => {});
      await pg.query(`DELETE FROM coach_availability_slots WHERE id = ANY($1::uuid[])`, [slotIds]).catch(() => {});
    }
    await pg.query(`DELETE FROM course_sessions WHERE course_period_id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pg.query(`DELETE FROM course_period_enrollments WHERE course_period_id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pg.query(`DELETE FROM course_periods WHERE id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE id = ANY($1::uuid[])`, [[studentId, secondStudentId]]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = $1`, [parentId]).catch(() => {});
    await pg.end().catch(() => {});
    await route.close().catch(() => {});
  }

  step('manual deduction cleanup complete');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
