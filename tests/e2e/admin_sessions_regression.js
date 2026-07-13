/*
 * F-R01 / F-R03 / F-M05 regression coverage on real routes and isolated rows.
 * No production data; all sentinels are removed in finally.
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signToken } = require('../../server/middlewares/adminAuth');
const sessionsRouter = require('../../server/routes/admin/sessions');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin/sessions', sessionsRouter);
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

async function call(base, method, routePath, { token, body } = {}) {
  const response = await fetch(`${base}${routePath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  const enrollmentA = `E2E-SESS-A-${suffix}`;
  const enrollmentB = `E2E-SESS-B-${suffix}`;
  const todayA = `E2E-TODAY-A-${suffix}`;
  const todayB = `E2E-TODAY-B-${suffix}`;
  const cancelledA = `E2E-CANCEL-A-${suffix}`;
  const cancelledB = `E2E-CANCEL-B-${suffix}`;
  const enrollmentIds = [enrollmentA, enrollmentB];
  const todayIds = [todayA, todayB];
  const cancelledIds = [cancelledA, cancelledB];

  try {
    const venues = await pg.query(`SELECT id FROM venues WHERE is_active = TRUE ORDER BY id LIMIT 2`);
    if (venues.rowCount < 2) throw new Error('test database needs two active venues');
    const venueA = venues.rows[0].id;
    const venueB = venues.rows[1].id;
    const today = new Date().toISOString().slice(0, 10);

    await pg.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, venue_id, course_type,
          original_price, final_price, status, submitted_at, total_sessions, used_sessions)
       VALUES ($1,$2,$3,$4,$5,$6,1,6000,6000,'confirmed',NOW(),6,2),
              ($7,$8,$9,$10,$11,$12,1,6000,6000,'confirmed',NOW(),6,2)`,
      [
        enrollmentA, `E2E sessions parent A ${suffix}`, `091${suffix.slice(0, 7)}`,
        [`E2E sessions student A ${suffix}`], `E2E coach A ${suffix}`, venueA,
        enrollmentB, `E2E sessions parent B ${suffix}`, `092${suffix.slice(0, 7)}`,
        [`E2E sessions student B ${suffix}`], `E2E coach B ${suffix}`, venueB,
      ]
    );
    await pg.query(
      `INSERT INTO admin_today_sessions
         (id, date, start_time, end_time, venue_id, coach, students, course_type, checkin_status)
       VALUES ($1,$2,'09:00','10:00',$3,$4,$5,1,'not_yet'),
              ($6,$2,'10:00','11:00',$7,$8,$9,1,'not_yet')`,
      [
        todayA, today, venueA, `E2E coach A ${suffix}`, [`E2E sessions student A ${suffix}`],
        todayB, venueB, `E2E coach B ${suffix}`, [`E2E sessions student B ${suffix}`],
      ]
    );
    await pg.query(
      `INSERT INTO admin_cancelled_sessions
         (id, date, start_time, period_id, parent_name, coach, venue_id, refunded)
       VALUES ($1,$2,'09:00',$3,$4,$5,$6,FALSE),
              ($7,$2,'10:00',$8,$9,$10,$11,FALSE)`,
      [
        cancelledA, today, enrollmentA, `E2E sessions parent A ${suffix}`, `E2E coach A ${suffix}`, venueA,
        cancelledB, enrollmentB, `E2E sessions parent B ${suffix}`, `E2E coach B ${suffix}`, venueB,
      ]
    );

    const staffA = signToken({
      sub: `e2e-staff-${suffix}`, username: `e2e-staff-${suffix}`, name: `E2E Staff ${suffix}`,
      role: 'staff', venue_id: venueA, venue_ids: [venueA],
    });
    const managerA = signToken({
      sub: `e2e-manager-${suffix}`, username: `e2e-manager-${suffix}`, name: `E2E Manager ${suffix}`,
      role: 'manager', venue_id: venueA, venue_ids: [venueA],
    });

    step('F-R01 session lists/backfill keep shared venue scope fail-closed');
    const range = await call(route.base, 'GET', `/api/admin/sessions?from=${today}&to=${today}&venueIds=${encodeURIComponent(venueB)}`, { token: staffA });
    assert(range.status === 200 && range.data.some((row) => row.id === todayA), 'out-of-scope filter cannot suppress the authorized scope into a cross-venue query');
    assert(!range.data.some((row) => row.id === todayB), 'F-R01 range never leaks the out-of-scope venue');
    const backfill = await call(route.base, 'POST', `/api/admin/sessions/${todayA}/backfill-checkin`, {
      token: staffA,
      body: { checkin_at: `${today}T09:05:00.000Z` },
    });
    assert(backfill.status === 200 && backfill.data?.checkin_status === 'checked_in', 'authorized F-R01 backfill succeeds');
    const foreignBackfill = await call(route.base, 'POST', `/api/admin/sessions/${todayB}/backfill-checkin`, {
      token: staffA,
      body: { checkin_at: `${today}T10:05:00.000Z` },
    });
    assert(foreignBackfill.status === 403, 'F-R01 backfill rejects another venue');

    step('F-R03 verify/checkin remains scoped and writes its existing audit contract');
    const ownVerify = await call(route.base, 'GET', `/api/admin/sessions/verify-checkin?periodId=${encodeURIComponent(enrollmentA)}`, { token: staffA });
    const foreignVerify = await call(route.base, 'GET', `/api/admin/sessions/verify-checkin?periodId=${encodeURIComponent(enrollmentB)}`, { token: staffA });
    assert(ownVerify.status === 200 && ownVerify.data?.found === true, 'F-R03 finds an authorized enrollment');
    assert(foreignVerify.status === 200 && foreignVerify.data?.found === false, 'F-R03 hides an out-of-scope enrollment');
    const checkin = await call(route.base, 'POST', '/api/admin/sessions/checkin', {
      token: staffA,
      body: { enrollmentId: enrollmentA },
    });
    assert(checkin.status === 200 && checkin.data?.ok === true, 'authorized F-R03 check-in succeeds');
    const checkinDb = await pg.query(
      `SELECT ae.experience_checked_in_at,
              COUNT(al.id)::int AS audits
         FROM admin_enrollments ae
         LEFT JOIN admin_enrollment_audit_logs al
           ON al.enrollment_id = ae.id AND al.action = '體驗課簽到'
        WHERE ae.id = $1 GROUP BY ae.id`,
      [enrollmentA]
    );
    assert(!!checkinDb.rows[0].experience_checked_in_at && checkinDb.rows[0].audits === 1, 'F-R03 persists timestamp and one existing audit entry');

    step('F-M05 remains manager-only, venue-scoped, and restores exactly one lesson');
    const cancelledList = await call(route.base, 'GET', '/api/admin/sessions/cancelled', { token: staffA });
    assert(cancelledList.status === 200 && cancelledList.data.some((row) => row.id === cancelledA), 'staff may inspect own-venue cancelled sessions');
    assert(!cancelledList.data.some((row) => row.id === cancelledB), 'cancelled list hides another venue');
    const staffRevive = await call(route.base, 'POST', `/api/admin/sessions/${cancelledA}/revive`, { token: staffA });
    assert(staffRevive.status === 403, 'staff cannot execute F-M05 restore');
    const foreignRevive = await call(route.base, 'POST', `/api/admin/sessions/${cancelledB}/revive`, { token: managerA });
    assert(foreignRevive.status === 403, 'manager cannot revive an out-of-scope venue');
    const revive = await call(route.base, 'POST', `/api/admin/sessions/${cancelledA}/revive`, { token: managerA });
    assert(revive.status === 200 && revive.data?.refunded === true, 'manager revives an authorized cancelled session');
    const reviveDb = await pg.query(
      `SELECT ae.used_sessions,
              (SELECT COUNT(*)::int FROM admin_enrollment_audit_logs
                WHERE enrollment_id = ae.id AND action LIKE '退課時段復活%') AS audits
         FROM admin_enrollments ae WHERE ae.id = $1`,
      [enrollmentA]
    );
    assert(Number(reviveDb.rows[0].used_sessions) === 1 && reviveDb.rows[0].audits === 1, 'F-M05 restores one lesson and writes one audit');
  } finally {
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    await pg.query(`DELETE FROM admin_cancelled_sessions WHERE id = ANY($1::text[])`, [cancelledIds]).catch(() => {});
    await pg.query(`DELETE FROM admin_today_sessions WHERE id = ANY($1::text[])`, [todayIds]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    await pg.end().catch(() => {});
    await route.close().catch(() => {});
  }

  step('F-R01/F-R03/F-M05 cleanup complete');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
