// Checkout multi-student × multi-period: 2 students × 4 periods must create 8
// single-student, single-period child orders under one checkout.
const { randomUUID } = require('crypto');
const { Client } = require('../../server/node_modules/pg');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const { call, assert, step } = require('./_lib');

(async () => {
  step('Checkout multi-student periods: 2 students × 4 periods → 8 children, total 48000');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const cleanup = { checkoutId: null, enrollmentIds: [] };
  // 夾具全部自建：demo-login 要伺服器開 ALLOW_DEMO_LOGIN 又要預先種 demo 家長，
  // 全新庫兩者都沒有。一對二在本區每人每期 6000 → 2 生 × 4 期 = 48000。
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const digits = String(parseInt(suffix, 16)).padStart(10, '0').slice(-8);
  const venueId = `MS${suffix.slice(0, 6).toUpperCase()}`;
  const parentId = randomUUID();
  const coachId = randomUUID();
  const staffId = `E2E-2X4-${suffix}`;
  let zoneId = null;

  try {
    zoneId = (await pg.query(
      `INSERT INTO pricing_zones (name, sessions_per_period, sort_order) VALUES ($1, 6, 996) RETURNING id`,
      [`2x4測試區${suffix}`]
    )).rows[0].id;
    await pg.query(
      `INSERT INTO venues (id, name, is_active, pricing_zone_id) VALUES ($1, $2, TRUE, $3)`,
      [venueId, `2x4測試館${suffix}`, zoneId]
    );
    await pg.query(
      `INSERT INTO course_type_configs
         (pricing_zone_id, course_type, label, min_students, max_students, sort_order, base_price, is_active)
       VALUES ($1, 2, '一對二', 1, 2, 2, 6000, TRUE)`,
      [zoneId]
    );
    // 家長端教練清單以 admin_staff（在職＋館別）為準，coaches 是 app 端檔案，兩列都要。
    await pg.query(
      `INSERT INTO admin_staff (id, name, role, venue_id, phone, multiplier, active, is_coach)
       VALUES ($1, $2, 'coach', $3, $4, 1.00, TRUE, TRUE)`,
      [staffId, `2x4教練${suffix}`, venueId, `05${digits}`]
    );
    await pg.query(
      `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active, pricing_multiplier)
       VALUES ($1, $2, $3, $4, TRUE, 1.00)`,
      [coachId, `2x4教練${suffix}`, `05${digits}`, staffId]
    );
    await pg.query(
      `INSERT INTO parents (id, name, phone, line_uid, is_active) VALUES ($1, $2, $3, $4, TRUE)`,
      [parentId, `2x4家長${suffix}`, `09${digits}`, `U2x4${suffix}`]
    );
    const students = (await pg.query(
      `INSERT INTO students (parent_id, name) VALUES ($1, $2), ($1, $3) RETURNING id, name`,
      [parentId, `2x4大寶${suffix}`, `2x4二寶${suffix}`]
    )).rows;
    const token = signParentToken({ parentId, phone: `09${digits}`, lineUid: `U2x4${suffix}` });

    const coaches = await call('GET', '/api/coaches', { token, query: { venueId } });
    assert(coaches.status === 200 && Array.isArray(coaches.data) && coaches.data.length > 0, '測試場館有可用教練');
    const coach = coaches.data.find((c) => Number(c.multiplier || c.pricing_multiplier || 1) === 1) || coaches.data[0];

    const created = await call('POST', '/api/enrollments', {
      token,
      body: {
        coach: { id: coach.id, name: coach.name },
        venue: { id: venueId, name: `2x4測試館${suffix}` },
        course_type: 2,
        students: students.map((s) => ({ id: s.id, name: s.name })),
        period_count: 4,
        request_id: `e2e-2x4-${Date.now()}`,
      },
    });
    assert(created.status === 201, `enrollment create 201，實際 ${created.status}`);
    cleanup.checkoutId = created.data.checkout_id || created.data.data?.checkout_id;
    cleanup.enrollmentIds = created.data.enrollment_ids || [];
    assert(cleanup.checkoutId, '回傳 checkout_id');
    assert(created.data.count === 8 && cleanup.enrollmentIds.length === 8, '回傳 8 筆子訂單 id');
    assert(created.data.period_count === 4 && created.data.student_count === 2, '回傳 period_count=4 / student_count=2');
    assert(Number(created.data.data?.total_amount) === 48000, 'route instruction total_amount=48000');

    const db = await pg.query(
      `SELECT cs.total_amount::int AS checkout_total,
              COUNT(ae.id)::int AS child_count,
              SUM(ae.final_price)::int AS child_sum,
              COUNT(DISTINCT ae.students[1])::int AS student_count,
              COUNT(DISTINCT ae.period_number)::int AS period_count,
              array_agg(DISTINCT ae.period_number ORDER BY ae.period_number) AS periods
         FROM checkout_sessions cs
         JOIN admin_enrollments ae ON ae.checkout_id = cs.checkout_id
        WHERE cs.checkout_id = $1
        GROUP BY cs.checkout_id, cs.total_amount`,
      [cleanup.checkoutId],
    );
    const row = db.rows[0];
    assert(row.child_count === 8, `DB 有 8 筆子訂單，實際 ${row.child_count}`);
    assert(row.checkout_total === 48000 && row.child_sum === 48000, `DB checkout/children 總額皆 48000`);
    assert(row.student_count === 2 && row.period_count === 4 && row.periods.join(',') === '1,2,3,4',
      'DB 子訂單涵蓋 2 位學員與 4 期');

    const mine = await call('GET', '/api/courses/mine', { token });
    assert(mine.status === 200, `courses/mine 200，實際 ${mine.status}`);
    const aggregate = mine.data.find((x) => x.checkout_id === cleanup.checkoutId && x.is_checkout_aggregate);
    const leaked = mine.data.filter((x) => cleanup.enrollmentIds.includes(x.id));
    assert(aggregate && Number(aggregate.final_price) === 48000, '我的課程回一張 48000 checkout 聚合卡');
    assert(aggregate.period_count === 4 && aggregate.sub_order_count === 8, '聚合卡顯示 4 期 / 8 子單');
    assert(leaked.length === 0, '我的課程未平鋪露出 8 筆子單');
  } finally {
    if (cleanup.enrollmentIds.length) {
      await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [cleanup.enrollmentIds]).catch(() => {});
      await pg.query(`DELETE FROM promotion_usages WHERE admin_enrollment_id = ANY($1::text[])`, [cleanup.enrollmentIds]).catch(() => {});
      await pg.query(`DELETE FROM course_period_enrollments WHERE course_period_id IN (SELECT id FROM course_periods WHERE admin_enrollment_id = ANY($1::text[]))`, [cleanup.enrollmentIds]).catch(() => {});
      await pg.query(`DELETE FROM course_periods WHERE admin_enrollment_id = ANY($1::text[])`, [cleanup.enrollmentIds]).catch(() => {});
      await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [cleanup.enrollmentIds]).catch(() => {});
    }
    if (cleanup.checkoutId) {
      await pg.query(`DELETE FROM checkout_invoices WHERE checkout_id=$1`, [cleanup.checkoutId]).catch(() => {});
      await pg.query(`DELETE FROM request_idempotency_ledger WHERE result_entity_id=$1`, [cleanup.checkoutId]).catch(() => {});
      await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id=$1`, [cleanup.checkoutId]).catch(() => {});
    }
    await pg.query(`DELETE FROM request_idempotency_ledger WHERE actor_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE parent_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM coaches WHERE id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM admin_staff WHERE id = $1`, [staffId]).catch(() => {});
    await pg.query(`DELETE FROM course_type_configs WHERE pricing_zone_id = $1`, [zoneId]).catch(() => {});
    await pg.query(`DELETE FROM venues WHERE id = $1`, [venueId]).catch(() => {});
    await pg.query(`DELETE FROM pricing_zones WHERE id = $1`, [zoneId]).catch(() => {});
    await pg.end();
  }

  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
