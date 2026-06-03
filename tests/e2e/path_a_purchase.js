// 路徑 A：核心購課（家長報名 → 末5碼 → 主管對帳 → 開通）
// 真整合：直接 INSERT 一筆 pending_payment enrollment → POST reconcile →
// 驗 status='confirmed' + audit log 寫入 + total_sessions = 6
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path A: 核心購課（建立 → 對帳 → 驗 confirmed）');

  const id = `e2e-A-${Date.now()}`;
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    await pg.query(
      `INSERT INTO admin_enrollments
        (id, parent_name, parent_phone, students, coach, venue_id, course_type,
         original_price, final_price, transfer_last_5, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
      [id, 'E2E測試家長', '0900000A01', ['E2E學員'],
       '王教練', 'B', 1, 6000, 6000, '12345', 'pending_payment'],
    );

    const token = await loginAdmin(
      process.env.ADMIN_USERNAME || 'manager',
      process.env.ADMIN_PASSWORD || 'manager',
    );
    // Task #39：reconcile 現要求發票號碼（^[A-Z]{2}\d{8}$）+ 發票圖片必填
    const r = await call('POST', `/api/admin/enrollments/${id}/reconcile`, {
      token, body: { by: 'e2e', invoice_number: 'AB12345678', invoice_image_url: '/uploads/e2e-invoice.png' },
    });
    assert(r.status === 200, `reconcile 200，實際 ${r.status}`);
    assert(r.data?.status === 'confirmed', `status=confirmed，實際 ${r.data?.status}`);
    assert(r.data?.total_sessions > 0, `total_sessions > 0`);

    const audit = await pg.query(
      `SELECT action FROM admin_enrollment_audit_logs WHERE enrollment_id=$1 ORDER BY id DESC LIMIT 1`, [id],
    );
    // audit action 現為「對帳通過（發票 AB12345678）」→ 用前綴比對
    assert(audit.rows[0]?.action?.startsWith('對帳通過'), `audit log 以 '對帳通過' 開頭，實際 '${audit.rows[0]?.action}'`);
  } finally {
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id=$1`, [id]);
    await pg.query(`DELETE FROM admin_enrollments WHERE id=$1`, [id]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
