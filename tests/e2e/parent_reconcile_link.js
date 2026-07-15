/*
 * 家長訂單 ↔ 後台待對帳母單 ↔ 對帳後家長課期的資料鏈回歸。
 *
 * 真正的 F-M02 UI 以 checkout 母單為單位，不是逐筆 enrollment：
 *   一對二、2 位學員、2 期 = 1 張 checkout + 4 筆金流子訂單。
 *   櫃檯一次對帳後，4 筆子訂單一起 confirmed，但只開 2 個共享課期、共 12 堂。
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signToken } = require('../../server/middlewares/adminAuth');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const enrollmentsRouter = require('../../server/routes/enrollments');
const adminCheckoutsRouter = require('../../server/routes/admin/checkouts');
const coursesRouter = require('../../server/routes/courses');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', enrollmentsRouter);
  app.use('/api/admin/checkouts', adminCheckoutsRouter);
  app.use('/api/courses', coursesRouter);
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

async function call(base, method, path, { token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
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
  step('Parent ↔ F-M02 checkout: 同一母單、四筆子單、對帳後兩期 12 堂');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();

  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const digits = String(parseInt(suffix, 16)).padStart(10, '0').slice(-8);
  const venueId = `RC${suffix.slice(0, 6).toUpperCase()}`;
  const parentId = randomUUID();
  const coachId = randomUUID();
  const courseType = 1000000 + (parseInt(suffix.slice(0, 6), 16) % 1000000);
  const parentPhone = `09${digits}`;
  const enrollmentIds = [];
  let checkoutId = null;
  let batchId = null;

  try {
    await pg.query(
      `INSERT INTO venues (id, name, is_active) VALUES ($1, $2, TRUE)`,
      [venueId, `對帳串接館${suffix}`]
    );
    await pg.query(
      `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active, pricing_multiplier)
       VALUES ($1, $2, $3, $4, TRUE, 1.00)`,
      [coachId, `對帳教練${suffix}`, `08${digits}`, `RECON-${suffix}`]
    );
    await pg.query(`INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2)`, [coachId, venueId]);
    await pg.query(
      `INSERT INTO parents (id, name, phone, line_uid, is_active)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [parentId, `對帳家長${suffix}`, parentPhone, `Ureconcile${suffix}`]
    );
    const students = await pg.query(
      `INSERT INTO students (parent_id, name)
       VALUES ($1, $2), ($1, $3)
       RETURNING id, name`,
      [parentId, `對帳大寶${suffix}`, `對帳二寶${suffix}`]
    );
    await pg.query(
      `INSERT INTO course_type_configs
         (course_type, label, min_students, max_students, sort_order, base_price, is_active)
       VALUES ($1, '對帳一對二測試', 1, 2, 998, 4500, TRUE)`,
      [courseType]
    );

    const parentToken = signParentToken({
      parentId,
      phone: parentPhone,
      lineUid: `Ureconcile${suffix}`,
    });
    const adminToken = signToken({
      sub: randomUUID(),
      username: 'reconcile-e2e-admin',
      name: '對帳驗證管理員',
      role: 'admin',
    });

    const created = await call(route.base, 'POST', '/api/enrollments', {
      token: parentToken,
      body: {
        coach: { id: coachId, name: `對帳教練${suffix}` },
        venue: { id: venueId, name: `對帳串接館${suffix}` },
        course_type: courseType,
        students: students.rows.map((student) => ({ id: student.id, name: student.name })),
        period_count: 2,
        request_id: `e2e-parent-reconcile-${suffix}`,
      },
    });
    assert(created.status === 201, `家長建立訂單 201，實際 ${created.status} ${JSON.stringify(created.data)}`);
    checkoutId = created.data.checkout_id;
    batchId = created.data.batch_id;
    enrollmentIds.push(...created.data.enrollment_ids);
    assert(created.data.count === 4 && created.data.period_count === 2 && created.data.student_count === 2,
      '家長回應為 1 張母單、2 生 × 2 期 = 4 筆子訂單');
    assert(Number(created.data.final_price) === 18000, `家長應付總額 18000，實際 ${created.data.final_price}`);

    // 家長端待付款：同一 checkout 聚合成一張卡。
    let parentMine = await call(route.base, 'GET', '/api/courses/mine', { token: parentToken });
    assert(parentMine.status === 200, `家長待付款清單 200，實際 ${parentMine.status}`);
    const pendingCards = (parentMine.data || []).filter((row) => row.checkout_id === checkoutId);
    assert(pendingCards.length === 1, `家長端同一母單只顯示 1 張待付款卡，實際 ${pendingCards.length}`);
    const pendingCard = pendingCards[0];
    assert(pendingCard.is_checkout_aggregate === true && pendingCard.sub_order_count === 4,
      '家長待付款卡保留母單聚合與 4 筆子訂單');
    assert(pendingCard.enrollment_batch_id === batchId && Number(pendingCard.final_price) === 18000,
      '家長待付款卡 batch 與總額正確');
    assert(pendingCard.period_count === 2 && (pendingCard.students || []).length === 2,
      '家長待付款卡顯示 2 期、2 位學員');

    // F-M02 真正 UI 資料源：/api/admin/checkouts?status=pending。
    let adminList = await call(route.base, 'GET', '/api/admin/checkouts?status=pending', { token: adminToken });
    assert(adminList.status === 200, `後台待對帳清單 200，實際 ${adminList.status}`);
    const checkout = (adminList.data || []).find((row) => row.checkout_id === checkoutId);
    assert(!!checkout, '後台待對帳清單找到同一 checkout_id');
    assert(checkout.enrollment_batch_id === batchId && checkout.parent_phone === parentPhone,
      '後台母單 batch 與家長身分對應正確');
    assert(checkout.order_count === 4 && (checkout.sub_orders || []).length === 4,
      '後台母單展開為同一組 4 筆子訂單');
    assert(checkout.family_count === 1
      && checkout.requires_separate_invoices === false
      && checkout.invoice_families?.length === 1,
    '一般單家庭 checkout 維持原本一張發票流程');
    assert(Number(checkout.total_amount) === 18000
      && checkout.sub_orders.reduce((sum, row) => sum + Number(row.final_price || 0), 0) === 18000,
    '後台母單總額與子訂單加總皆為 18000');
    assert(checkout.sub_orders.map((row) => row.period_number).sort().join(',') === '1,1,2,2',
      '後台子訂單期別為第 1 期兩筆、第 2 期兩筆');
    assert(checkout.sub_orders.map((row) => row.id).sort().join(',') === enrollmentIds.slice().sort().join(','),
      '家長建立回傳的子訂單 ID 與後台清單完全一致');

    // 櫃檯依 UI 實際流程，一次對整張 checkout 對帳。
    const reconciled = await call(route.base, 'POST', `/api/admin/checkouts/${checkoutId}/reconcile`, {
      token: adminToken,
      body: {
        invoice_number: 'RC12345678',
        invoice_image_url: '/uploads/e2e-reconcile-invoice.png',
      },
    });
    assert(reconciled.status === 200, `母單對帳 200，實際 ${reconciled.status} ${JSON.stringify(reconciled.data)}`);
    assert(reconciled.data.payment_status === 'paid' && reconciled.data.current_route_state === 'paid',
      '後台母單對帳後 payment/current state 都是 paid');
    assert((reconciled.data.sub_orders || []).every((row) => row.status === 'confirmed'),
      '一次母單對帳讓 4 筆子訂單全部 confirmed');

    adminList = await call(route.base, 'GET', '/api/admin/checkouts?status=pending', { token: adminToken });
    assert(!(adminList.data || []).some((row) => row.checkout_id === checkoutId),
      '已對帳母單從 F-M02 待對帳清單移除');

    const periods = await pg.query(
      `SELECT id, period_number, total_sessions
         FROM course_periods
        WHERE enrollment_batch_id = $1
        ORDER BY period_number`,
      [batchId]
    );
    assert(periods.rowCount === 2, `對帳後只建立 2 個共享課期，實際 ${periods.rowCount}`);
    assert(periods.rows.every((row) => row.total_sessions === 6)
      && periods.rows.reduce((sum, row) => sum + row.total_sessions, 0) === 12,
    '兩個課期各 6 堂，總權益 12 堂而非 24 堂');

    parentMine = await call(route.base, 'GET', '/api/courses/mine', { token: parentToken });
    const activeCards = (parentMine.data || []).filter((row) => row.enrollment_batch_id === batchId);
    assert(activeCards.length === 2, `家長端對帳後顯示 2 張課期卡，實際 ${activeCards.length}`);
    assert(activeCards.every((row) => row.lifecycle === 'active' && row.total_sessions === 6),
      '家長端兩張課期卡皆為進行中、各 6 堂');
    assert(activeCards.reduce((sum, row) => sum + row.total_sessions, 0) === 12,
      '家長端對帳後合計 12 堂');
    assert(!activeCards.some((row) => row.is_checkout_aggregate),
      '完成對帳後不再顯示待付款母單聚合卡');

    const audit = await pg.query(
      `SELECT COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE by_user = '對帳驗證管理員')::int AS correct_actor
         FROM admin_enrollment_audit_logs
        WHERE enrollment_id = ANY($1::text[])
          AND action LIKE 'checkout 對帳通過%'`,
      [enrollmentIds]
    );
    assert(audit.rows[0].count === 4 && audit.rows[0].correct_actor === 4,
      '4 筆子訂單皆留下由登入管理員產生的對帳 audit');

    step('PASS: 家長母單、F-M02 待對帳清單、母單對帳與 12 堂課期資料鏈一致');
  } finally {
    if (enrollmentIds.length) {
      await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    }
    if (batchId) {
      await pg.query(`DELETE FROM course_periods WHERE enrollment_batch_id = $1`, [batchId]).catch(() => {});
    }
    if (checkoutId) {
      await pg.query(`DELETE FROM checkout_invoices WHERE checkout_id = $1`, [checkoutId]).catch(() => {});
    }
    if (enrollmentIds.length) {
      await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    }
    if (checkoutId) {
      await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id = $1`, [checkoutId]).catch(() => {});
    }
    await pg.query(`DELETE FROM request_idempotency_ledger WHERE actor_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE parent_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM coaches WHERE id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM course_type_configs WHERE course_type = $1`, [courseType]).catch(() => {});
    await pg.query(`DELETE FROM venues WHERE id = $1`, [venueId]).catch(() => {});
    await route.close().catch(() => {});
    await pg.end().catch(() => {});
  }
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
