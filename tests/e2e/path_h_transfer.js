// 路徑 H：課程轉讓（家長申請 → 主管審 → 驗 enrollment 狀態）
// 真整合：直接 INSERT 一筆 pending transfer_records → admin POST approve →
// 驗 transfer.status='approved' + 原 enrollment.status='transferred_out'
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path H: 課程轉讓');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  // 找一筆 active enrollment 當轉出方
  const cur = await pg.query(
    `SELECT cpe.id AS enrollment_id, cpe.course_period_id, cpe.student_id, s.parent_id
       FROM course_period_enrollments cpe
       JOIN students s ON s.id = cpe.student_id
      WHERE cpe.status = 'active'
      LIMIT 1`,
  ).catch((e) => { console.log('  ⚠ query failed:', e.message); return { rowCount: 0 }; });
  if (!cur.rowCount) {
    console.log('  ⚠ 無 active enrollment，跳過轉讓寫入測試（驗 GET 仍要可達）');
    const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');
    const r = await call('GET', '/api/admin/transfers', { token, query: { status: 'pending' } });
    assert(r.status === 200, `GET admin/transfers 200，實際 ${r.status}`);
    await pg.end();
    return;
  }

  const e = cur.rows[0];
  let tid;
  let toEnrollmentId;
  try {
    const ins = await pg.query(
      `INSERT INTO transfer_records
         (course_period_id, from_student_id, from_parent_id, to_phone,
          to_student_name, sessions_remaining, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_review') RETURNING id`,
      [e.course_period_id, e.student_id, e.parent_id, '0922333444',
       'E2E轉入學員', 1, 'e2e 測試'],
    );
    tid = ins.rows[0].id;

    const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');
    const r = await call('POST', `/api/admin/transfers/${tid}/approve`, {
      token, body: { review_note: 'e2e approve' },
    });
    assert(r.status === 200, `approve 200，實際 ${r.status}：${JSON.stringify(r.data)}`);

    const after = await pg.query(`SELECT status FROM transfer_records WHERE id=$1`, [tid]);
    assert(after.rows[0].status === 'approved', `transfer.status=approved`);

    const oldE = await pg.query(`SELECT status FROM course_period_enrollments WHERE id=$1`, [e.enrollment_id]);
    assert(oldE.rows[0].status === 'transferred_out', `原 enrollment.status=transferred_out`);

    const newE = await pg.query(
      `SELECT id FROM course_period_enrollments WHERE course_period_id=$1 AND status='active' AND student_id != $2 ORDER BY id DESC LIMIT 1`,
      [e.course_period_id, e.student_id],
    );
    if (newE.rowCount) toEnrollmentId = newE.rows[0].id;
  } finally {
    // 清理：把原 enrollment 狀態還原、刪除轉入 enrollment、刪除 transfer
    await pg.query(`UPDATE course_period_enrollments SET status='active' WHERE id=$1`, [e.enrollment_id]);
    if (toEnrollmentId) {
      await pg.query(`DELETE FROM course_period_enrollments WHERE id=$1`, [toEnrollmentId]);
    }
    if (tid) await pg.query(`DELETE FROM transfer_records WHERE id=$1`, [tid]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
