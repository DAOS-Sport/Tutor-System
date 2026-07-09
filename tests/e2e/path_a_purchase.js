// 路徑 A：核心購課（3 期子訂單 → checkout 對帳 → 全部開通）
// 真整合：直接 INSERT 一張 checkout + 三筆 pending_payment enrollment →
// POST checkout reconcile → 驗 checkout paid + 三筆子訂單 confirmed。
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path A: 核心購課（checkout 建立 → 對帳 → 驗三筆 confirmed）');

  const seed = Date.now();
  const ids = [1, 2, 3].map((n) => `e2e-A-${seed}-${n}`);
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  let checkoutId;
  try {
    const batch = (await pg.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    const checkout = await pg.query(
      `INSERT INTO checkout_sessions
         (enrollment_batch_id, total_amount, payment_status, current_route_state, transfer_last_5)
       VALUES ($1, 18000, 'pending_reconcile', 'pending_reconcile', '12345')
       RETURNING checkout_id`,
      [batch],
    );
    checkoutId = checkout.rows[0].checkout_id;
    for (let i = 0; i < ids.length; i += 1) {
      await pg.query(
        `INSERT INTO admin_enrollments
          (id, parent_name, parent_phone, students, coach, venue_id, course_type,
           original_price, final_price, transfer_last_5, status, submitted_at,
           period_count, period_number, enrollment_batch_id, checkout_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),1,$12,$13,$14)`,
        [ids[i], 'E2E測試家長', '0900000A01', ['E2E學員'],
         '王教練', 'B', 1, 6000, 6000, '12345', 'pending_payment', i + 1, batch, checkoutId],
      );
    }

    const token = await loginAdmin(
      process.env.ADMIN_USERNAME || 'admin',
      process.env.ADMIN_PASSWORD || 'admin',
    );
    // Task #39：reconcile 現要求發票號碼（^[A-Z]{2}\d{8}$）+ 發票圖片必填
    const r = await call('POST', `/api/admin/checkouts/${checkoutId}/reconcile`, {
      token, body: { by: 'e2e', invoice_number: 'AB12345678', invoice_image_url: '/uploads/e2e-invoice.png' },
    });
    assert(r.status === 200, `reconcile 200，實際 ${r.status}`);
    assert(r.data?.payment_status === 'paid', `checkout status=paid，實際 ${r.data?.payment_status}`);
    assert((r.data?.sub_orders || []).length === 3, `checkout 有 3 筆子訂單`);

    const confirmed = await pg.query(
      `SELECT COUNT(*)::int AS n FROM admin_enrollments WHERE id = ANY($1::text[]) AND status = 'confirmed'`,
      [ids],
    );
    assert(confirmed.rows[0].n === 3, `三筆子訂單皆 confirmed`);

    const audit = await pg.query(
      `SELECT COUNT(*)::int AS n FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[]) AND action LIKE 'checkout 對帳通過%'`,
      [ids],
    );
    assert(audit.rows[0].n === 3, `三筆 audit log 皆寫入 checkout 對帳通過`);
  } finally {
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [ids]);
    await pg.query(`DELETE FROM course_periods WHERE admin_enrollment_id = ANY($1::text[])`, [ids]).catch(() => {});
    await pg.query(`DELETE FROM checkout_invoices WHERE checkout_id=$1`, [checkoutId]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [ids]);
    if (checkoutId) await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id=$1`, [checkoutId]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
