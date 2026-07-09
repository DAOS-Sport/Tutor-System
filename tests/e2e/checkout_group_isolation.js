// 團報 checkout 隔離：同一團報 batch 內 A/B 各有 checkout。
// A 對帳 paid 時不得開課；必須等 B 也 paid 後才建立 group course_period。
const { randomUUID } = require('crypto');
const { Client } = require('../../server/node_modules/pg');
const { assert, step } = require('./_lib');
const enrollmentRouter = require('../../server/routes/admin/enrollments');

const { ensureGroupCoursePeriod } = enrollmentRouter._checkoutInternals;

(async () => {
  step('Checkout group isolation: all related checkouts must be paid before opening group course');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const suffix = Date.now();
  const phoneA = `091${String(suffix).slice(-7)}`;
  const phoneB = `092${String(suffix).slice(-7)}`;
  const ids = {
    groupOrderId: null,
    checkoutA: null,
    checkoutB: null,
    enrollmentA: `e2e-GA-${suffix}`,
    enrollmentB: `e2e-GB-${suffix}`,
    parentA: null,
    parentB: null,
    studentA: null,
    studentB: null,
  };

  try {
    const coach = await pg.query(
      `SELECT c.id AS coach_id, COALESCE(cv.venue_id, 'B') AS venue_id
         FROM coaches c
         LEFT JOIN coach_venues cv ON cv.coach_id = c.id
        WHERE c.is_active = TRUE
        ORDER BY c.created_at, c.id
        LIMIT 1`
    );
    assert(coach.rowCount === 1, '有可用教練');
    const { coach_id: coachId, venue_id: venueId } = coach.rows[0];

    ids.parentA = (await pg.query(
      `INSERT INTO parents (phone, name, is_active) VALUES ($1, 'E2E團報A', TRUE) RETURNING id`,
      [phoneA]
    )).rows[0].id;
    ids.parentB = (await pg.query(
      `INSERT INTO parents (phone, name, is_active) VALUES ($1, 'E2E團報B', TRUE) RETURNING id`,
      [phoneB]
    )).rows[0].id;
    ids.studentA = (await pg.query(
      `INSERT INTO students (parent_id, name) VALUES ($1, 'E2E A 學員') RETURNING id`,
      [ids.parentA]
    )).rows[0].id;
    ids.studentB = (await pg.query(
      `INSERT INTO students (parent_id, name) VALUES ($1, 'E2E B 學員') RETURNING id`,
      [ids.parentB]
    )).rows[0].id;

    ids.groupOrderId = (await pg.query(
      `INSERT INTO group_orders
         (leader_parent_id, venue_id, course_type, coach_id, status, join_token, min_students, max_students, roster_approved)
       VALUES ($1, $2, 2, $3, 'approved', $4, 2, 2, TRUE)
       RETURNING id`,
      [ids.parentA, venueId, coachId, `e2e-${suffix}-${randomUUID()}`]
    )).rows[0].id;
    await pg.query(
      `INSERT INTO group_order_members
         (group_order_id, parent_id, student_names, student_ids, is_leader, status)
       VALUES
         ($1, $2, ARRAY['E2E A 學員'], ARRAY[$3]::uuid[], TRUE, 'joined'),
         ($1, $4, ARRAY['E2E B 學員'], ARRAY[$5]::uuid[], FALSE, 'joined')`,
      [ids.groupOrderId, ids.parentA, ids.studentA, ids.parentB, ids.studentB]
    );

    const batchId = randomUUID();
    ids.checkoutA = (await pg.query(
      `INSERT INTO checkout_sessions
         (parent_id, enrollment_batch_id, total_amount, payment_status, current_route_state)
       VALUES ($1, $2, 9000, 'paid', 'paid')
       RETURNING checkout_id`,
      [ids.parentA, batchId]
    )).rows[0].checkout_id;
    ids.checkoutB = (await pg.query(
      `INSERT INTO checkout_sessions
         (parent_id, enrollment_batch_id, total_amount, payment_status, current_route_state)
       VALUES ($1, $2, 9000, 'pending_reconcile', 'pending_reconcile')
       RETURNING checkout_id`,
      [ids.parentB, batchId]
    )).rows[0].checkout_id;

    await pg.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
          original_price, final_price, status, submitted_at, group_order_id, is_group_shared,
          period_count, period_number, enrollment_batch_id, checkout_id)
       VALUES
         ($1, 'E2E團報A', $2, ARRAY['E2E A 學員'], 'E2E教練', $3, $4, 2,
          9000, 9000, 'confirmed', NOW(), $5, TRUE, 1, 1, $6, $7),
         ($8, 'E2E團報B', $9, ARRAY['E2E B 學員'], 'E2E教練', $3, $4, 2,
          9000, 9000, 'confirmed', NOW(), $5, TRUE, 1, 1, $6, $10)`,
      [ids.enrollmentA, phoneA, coachId, venueId, ids.groupOrderId, batchId, ids.checkoutA,
       ids.enrollmentB, phoneB, ids.checkoutB]
    );

    const enrollmentA = (await pg.query(`SELECT * FROM admin_enrollments WHERE id = $1`, [ids.enrollmentA])).rows[0];
    await ensureGroupCoursePeriod(pg, enrollmentA, 6);
    const before = await pg.query(`SELECT COUNT(*)::int AS n FROM course_periods WHERE group_order_id = $1`, [ids.groupOrderId]);
    assert(before.rows[0].n === 0, '只有 A checkout paid 時不建立團報課程');

    await pg.query(
      `UPDATE checkout_sessions SET payment_status = 'paid', current_route_state = 'paid' WHERE checkout_id = $1`,
      [ids.checkoutB]
    );
    await ensureGroupCoursePeriod(pg, enrollmentA, 6);
    const after = await pg.query(`SELECT COUNT(*)::int AS n FROM course_periods WHERE group_order_id = $1`, [ids.groupOrderId]);
    assert(after.rows[0].n === 1, 'A/B checkout 都 paid 後才建立團報課程');
  } finally {
    if (ids.groupOrderId) {
      await pg.query(`DELETE FROM course_period_enrollments WHERE course_period_id IN (SELECT id FROM course_periods WHERE group_order_id = $1)`, [ids.groupOrderId]).catch(() => {});
      await pg.query(`DELETE FROM course_periods WHERE group_order_id = $1`, [ids.groupOrderId]).catch(() => {});
    }
    await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [[ids.enrollmentA, ids.enrollmentB]]).catch(() => {});
    if (ids.checkoutA || ids.checkoutB) await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::uuid[])`, [[ids.checkoutA, ids.checkoutB].filter(Boolean)]).catch(() => {});
    if (ids.groupOrderId) await pg.query(`DELETE FROM group_order_members WHERE group_order_id = $1`, [ids.groupOrderId]).catch(() => {});
    if (ids.groupOrderId) await pg.query(`DELETE FROM group_orders WHERE id = $1`, [ids.groupOrderId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE id = ANY($1::uuid[])`, [[ids.studentA, ids.studentB].filter(Boolean)]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [[ids.parentA, ids.parentB].filter(Boolean)]).catch(() => {});
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
