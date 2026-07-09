// Checkout multi-student × multi-period: 2 students × 4 periods must create 8
// single-student, single-period child orders under one checkout.
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step } = require('./_lib');

(async () => {
  step('Checkout multi-student periods: 2 students × 4 periods → 8 children, total 48000');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const cleanup = { checkoutId: null, enrollmentIds: [] };

  try {
    const login = await call('POST', '/api/auth/demo-login', {
      body: { username: 'custom', password: 'custom' },
    });
    assert(login.status === 200, `parent demo login 200，實際 ${login.status}`);
    const parent = login.data.parent || login.data;
    const token = login.data.token || parent.token;
    const students = (parent.students || []).filter((s) => s.is_active !== false).slice(0, 2);
    assert(students.length === 2, 'demo parent 有 2 位可用學員');

    const coaches = await call('GET', '/api/coaches', { token, query: { venueId: 'B' } });
    assert(coaches.status === 200 && Array.isArray(coaches.data) && coaches.data.length > 0, 'B 場館有可用教練');
    const coach = coaches.data.find((c) => Number(c.multiplier || c.pricing_multiplier || 1) === 1) || coaches.data[0];

    const created = await call('POST', '/api/enrollments', {
      token,
      body: {
        coach: { id: coach.id, name: coach.name },
        venue: { id: 'B', name: '新北高中' },
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
      await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id=$1`, [cleanup.checkoutId]).catch(() => {});
    }
    await pg.end();
  }

  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
