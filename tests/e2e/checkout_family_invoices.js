/*
 * 歷史／匯入混合 checkout 的分家庭發票相容測試。
 *
 * 新團報本來就是每家庭各一張 checkout；本測試刻意模擬舊資料把 A/B 兩戶、
 * 各 2 期放進同一張 checkout。F-M02 必須顯示兩戶，拒絕舊式單張發票，並在
 * 一次原子對帳中把各戶發票只寫回自己的子訂單，課程仍只開 2 期 × 6 堂。
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signToken } = require('../../server/middlewares/adminAuth');
const adminCheckoutsRouter = require('../../server/routes/admin/checkouts');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin/checkouts', adminCheckoutsRouter);
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
  step('F-M02 mixed-family checkout: 兩戶必須分開開立兩張發票');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();

  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const phoneDigitsA = String(parseInt(suffix.slice(0, 8), 16)).padStart(8, '0').slice(-8);
  const phoneDigitsB = String(parseInt(suffix.slice(2, 10), 16)).padStart(8, '0').slice(-8);
  const phoneA = `09${phoneDigitsA}`;
  const phoneB = `08${phoneDigitsB}`;
  const parentA = randomUUID();
  const parentB = randomUUID();
  const studentA = randomUUID();
  const studentB = randomUUID();
  const groupOrderId = randomUUID();
  const checkoutId = randomUUID();
  const batchId = randomUUID();
  const enrollmentIds = [1, 2].flatMap((period) => [
    `E2E-FAMILY-A-${period}-${suffix}`,
    `E2E-FAMILY-B-${period}-${suffix}`,
  ]);

  try {
    const refs = await pg.query(
      `SELECT c.id AS coach_id, cv.venue_id
         FROM coaches c
         JOIN coach_venues cv ON cv.coach_id = c.id
         JOIN venues v ON v.id = cv.venue_id
        WHERE c.is_active = TRUE AND v.is_active = TRUE
        ORDER BY c.created_at, c.id, cv.venue_id
        LIMIT 1`
    );
    if (!refs.rowCount) throw new Error('test database needs one active coach with an active venue');
    const { coach_id: coachId, venue_id: venueId } = refs.rows[0];

    await pg.query(
      `INSERT INTO parents (id, name, phone, is_active, primary_venue_id)
       VALUES ($1,$2,$3,TRUE,$7),($4,$5,$6,TRUE,$7)`,
      [parentA, `發票家庭A${suffix}`, phoneA, parentB, `發票家庭B${suffix}`, phoneB, venueId]
    );
    await pg.query(
      `INSERT INTO students (id, parent_id, name, is_active)
       VALUES ($1,$2,$3,TRUE),($4,$5,$6,TRUE)`,
      [studentA, parentA, `發票學員A${suffix}`, studentB, parentB, `發票學員B${suffix}`]
    );
    await pg.query(
      `INSERT INTO group_orders
         (id, leader_parent_id, venue_id, course_type, coach_id, status, join_token,
          min_students, max_students, period_count, roster_approved)
       VALUES ($1,$2,$3,2,$4,'approved',$5,2,2,2,TRUE)`,
      [groupOrderId, parentA, venueId, coachId, `e2e-family-invoice-${suffix}`]
    );
    await pg.query(
      `INSERT INTO group_order_members
         (group_order_id, parent_id, student_names, student_ids, is_leader, status,
          payment_confirmed, carrier)
       VALUES
         ($1,$2,ARRAY[$3]::text[],ARRAY[$4]::uuid[],TRUE,'joined',FALSE,NULL),
         ($1,$5,ARRAY[$6]::text[],ARRAY[$7]::uuid[],FALSE,'joined',FALSE,NULL)`,
      [
        groupOrderId,
        parentA,
        `發票學員A${suffix}`,
        studentA,
        parentB,
        `發票學員B${suffix}`,
        studentB,
      ]
    );
    await pg.query(
      `INSERT INTO checkout_sessions
         (checkout_id, parent_id, enrollment_batch_id, total_amount, payment_status,
          current_route_state, transfer_last_5)
       VALUES ($1,$2,$3,18000,'pending_reconcile','pending_reconcile','54321')`,
      [checkoutId, parentA, batchId]
    );

    for (let period = 1; period <= 2; period += 1) {
      await pg.query(
        `INSERT INTO admin_enrollments
           (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
            original_price, final_price, status, submitted_at, group_order_id, is_group_shared,
            period_count, period_number, enrollment_batch_id, checkout_id, total_sessions,
            used_sessions, carrier)
         VALUES
           ($1,$2,$3,ARRAY[$4]::text[],'E2E 分戶發票教練',$5,$6,2,
            4000,4000,'pending_payment',NOW(),$7,TRUE,1,$8,$9,$10,6,0,'/OLD-A'),
           ($11,$12,$13,ARRAY[$14]::text[],'E2E 分戶發票教練',$5,$6,2,
            5000,5000,'pending_payment',NOW(),$7,TRUE,1,$8,$9,$10,6,0,NULL)`,
        [
          `E2E-FAMILY-A-${period}-${suffix}`,
          `發票家庭A${suffix}`,
          period === 1 ? `${phoneA.slice(0, 4)}-${phoneA.slice(4)}` : phoneA,
          `發票學員A${suffix}`,
          coachId,
          venueId,
          groupOrderId,
          period,
          batchId,
          checkoutId,
          `E2E-FAMILY-B-${period}-${suffix}`,
          `發票家庭B${suffix}`,
          phoneB,
          `發票學員B${suffix}`,
        ]
      );
    }

    const adminToken = signToken({
      sub: randomUUID(),
      username: 'family-invoice-e2e-admin',
      name: '分戶發票驗證管理員',
      role: 'admin',
    });

    const detail = await call(route.base, 'GET', `/api/admin/checkouts/${checkoutId}`, { token: adminToken });
    assert(detail.status === 200, `F-M02 checkout 詳情 200，實際 ${detail.status}`);
    assert(detail.data.family_count === 2 && detail.data.requires_separate_invoices === true,
      '清單／彈窗資料契約標示 2 個家庭、必須分開發票');
    assert(detail.data.invoice_families.length === 2,
      '後端提供兩筆家庭摘要供 F-M02 彈窗直接映射');
    const familyA = detail.data.invoice_families.find((family) => family.parent_name === `發票家庭A${suffix}`);
    const familyB = detail.data.invoice_families.find((family) => family.parent_name === `發票家庭B${suffix}`);
    assert(familyA && familyB, '兩戶依家長帳號歸戶，不依學員姓名猜測');
    assert(Number(familyA.amount) === 8000 && familyA.order_count === 2,
      'A 戶兩期品項加總 8,000 元');
    assert(Number(familyB.amount) === 10000 && familyB.order_count === 2,
      'B 戶兩期品項加總 10,000 元');
    assert(Number(familyA.amount) + Number(familyB.amount) === Number(detail.data.total_amount),
      '兩戶發票金額加總與 checkout 應收總額一致');

    const legacySingleInvoice = await call(route.base, 'POST', `/api/admin/checkouts/${checkoutId}/reconcile`, {
      token: adminToken,
      body: {
        invoice_number: 'LS12345678',
        invoice_image_url: '/uploads/e2e-legacy-single-invoice.png',
      },
    });
    assert(legacySingleInvoice.status === 400
      && legacySingleInvoice.data?.code === 'FAMILY_INVOICES_REQUIRED',
    '混合家庭付款單拒絕舊式單張發票 payload');
    const unchanged = await pg.query(
      `SELECT
         (SELECT payment_status FROM checkout_sessions WHERE checkout_id = $1) AS checkout_status,
         (SELECT COUNT(*)::int FROM admin_enrollments
           WHERE checkout_id = $1 AND status <> 'pending_payment') AS changed_orders,
         (SELECT COUNT(*)::int FROM checkout_invoices WHERE checkout_id = $1) AS invoices`,
      [checkoutId]
    );
    assert(unchanged.rows[0].checkout_status === 'pending_reconcile'
      && unchanged.rows[0].changed_orders === 0
      && unchanged.rows[0].invoices === 0,
    '拒絕單張發票時整個交易 rollback，不留下半套資料');

    const reconciled = await call(route.base, 'POST', `/api/admin/checkouts/${checkoutId}/reconcile`, {
      token: adminToken,
      body: {
        family_invoices: [
          {
            family_key: familyA.family_key,
            invoice_number: 'FA12345678',
            invoice_image_url: '/uploads/e2e-family-a-invoice.png',
            invoice_url: 'https://example.test/invoice/family-a',
            carrier: '/FAMILY-A',
          },
          {
            family_key: familyB.family_key,
            invoice_number: 'FB12345678',
            invoice_image_url: '/uploads/e2e-family-b-invoice.png',
            invoice_url: 'https://example.test/invoice/family-b',
            carrier: '/FAMILY-B',
          },
        ],
      },
    });
    assert(reconciled.status === 200, `兩戶兩張發票對帳 200，實際 ${reconciled.status} ${JSON.stringify(reconciled.data)}`);
    assert(reconciled.data.payment_status === 'paid'
      && (reconciled.data.sub_orders || []).every((order) => order.status === 'confirmed'),
    '一次對帳原子開通四筆子訂單並將母單設為 paid');

    const orders = await pg.query(
      `SELECT parent_phone, invoice_number, invoice_image_url, invoice_url, carrier, status
         FROM admin_enrollments
        WHERE checkout_id = $1
        ORDER BY parent_phone, period_number`,
      [checkoutId]
    );
    const ordersA = orders.rows.filter((row) => row.parent_phone.replace(/\D/g, '') === phoneA);
    const ordersB = orders.rows.filter((row) => row.parent_phone.replace(/\D/g, '') === phoneB);
    assert(ordersA.length === 2 && ordersA.every((row) => row.invoice_number === 'FA12345678'
      && row.invoice_image_url.endsWith('family-a-invoice.png') && row.carrier === '/FAMILY-A'),
    'A 戶兩期只寫入 A 戶發票與載具');
    assert(ordersB.length === 2 && ordersB.every((row) => row.invoice_number === 'FB12345678'
      && row.invoice_image_url.endsWith('family-b-invoice.png') && row.carrier === '/FAMILY-B'),
    'B 戶兩期只寫入 B 戶發票與載具');

    const invoices = await pg.query(
      `SELECT family_key, amount, invoice_number, invoice_image_url
         FROM checkout_invoices
        WHERE checkout_id = $1
        ORDER BY invoice_number`,
      [checkoutId]
    );
    assert(invoices.rowCount === 2 && invoices.rows.every((invoice) => invoice.family_key),
      'checkout_invoices 保存兩筆具家庭鍵的發票，不覆蓋成一筆');
    assert(Number(invoices.rows[0].amount) + Number(invoices.rows[1].amount) === 18000,
      '資料庫兩張發票金額合計 18,000 元');
    assert(invoices.rows.map((invoice) => invoice.invoice_number).join(',') === 'FA12345678,FB12345678',
      '資料庫保留兩個不同發票號碼');

    const members = await pg.query(
      `SELECT p.phone, gom.payment_confirmed, gom.carrier
         FROM group_order_members gom
         JOIN parents p ON p.id = gom.parent_id
        WHERE gom.group_order_id = $1`,
      [groupOrderId]
    );
    assert(members.rows.find((member) => member.phone === phoneA)?.payment_confirmed === true
      && members.rows.find((member) => member.phone === phoneA)?.carrier === '/FAMILY-A',
    'A 戶團報付款狀態及載具只回寫 A 成員');
    assert(members.rows.find((member) => member.phone === phoneB)?.payment_confirmed === true
      && members.rows.find((member) => member.phone === phoneB)?.carrier === '/FAMILY-B',
    'B 戶團報付款狀態及載具只回寫 B 成員');

    const periods = await pg.query(
      `SELECT cp.id, cp.period_number, cp.total_sessions,
              COUNT(cpe.student_id)::int AS roster_count
         FROM course_periods cp
         LEFT JOIN course_period_enrollments cpe ON cpe.course_period_id = cp.id
        WHERE cp.group_order_id = $1
        GROUP BY cp.id
        ORDER BY cp.period_number`,
      [groupOrderId]
    );
    assert(periods.rowCount === 2 && periods.rows.every((period) => Number(period.total_sessions) === 6),
      '跨戶開兩張發票不改課權：仍只建立 2 期、每期 6 堂');
    assert(periods.rows.every((period) => period.roster_count === 2),
      '每一期共用課程名單仍只有 A/B 兩位學員');

    const audit = await pg.query(
      `SELECT COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE action LIKE '%FA12345678%')::int AS family_a,
              COUNT(*) FILTER (WHERE action LIKE '%FB12345678%')::int AS family_b
         FROM admin_enrollment_audit_logs
        WHERE enrollment_id = ANY($1::text[])
          AND action LIKE 'checkout 對帳通過%'`,
      [enrollmentIds]
    );
    assert(audit.rows[0].count === 4 && audit.rows[0].family_a === 2 && audit.rows[0].family_b === 2,
      '四筆子訂單 audit 各自記錄正確家庭發票');

    const pending = await call(route.base, 'GET', '/api/admin/checkouts?status=pending', { token: adminToken });
    assert(!(pending.data || []).some((row) => row.checkout_id === checkoutId),
      '完成兩張發票對帳後，該付款單從 F-M02 待對帳清單移除');

    step('PASS: F-M02 清單、家庭發票欄位、資料庫歸戶與課程開通資料鏈一致');
  } finally {
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    await pg.query(
      `DELETE FROM course_period_enrollments
        WHERE course_period_id IN (SELECT id FROM course_periods WHERE group_order_id = $1)`,
      [groupOrderId]
    ).catch(() => {});
    await pg.query(`DELETE FROM course_periods WHERE group_order_id = $1`, [groupOrderId]).catch(() => {});
    await pg.query(`DELETE FROM checkout_invoices WHERE checkout_id = $1`, [checkoutId]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id = $1`, [checkoutId]).catch(() => {});
    await pg.query(`DELETE FROM group_order_members WHERE group_order_id = $1`, [groupOrderId]).catch(() => {});
    await pg.query(`DELETE FROM group_orders WHERE id = $1`, [groupOrderId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE id = ANY($1::uuid[])`, [[studentA, studentB]]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [[parentA, parentB]]).catch(() => {});
    await route.close().catch(() => {});
    await pg.end().catch(() => {});
  }
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
