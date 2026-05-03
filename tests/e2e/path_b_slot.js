// 路徑 B：排課選槽 + 體驗課簽到（真整合）
// 1) 寫一筆 admin_enrollments(status='confirmed', experience_checked_in_at=NULL)
// 2) 呼叫 POST /api/admin/sessions/checkin → 驗 experience_checked_in_at 被填
// 3) 驗 admin_enrollment_audit_logs 有「體驗課簽到」一筆
// 4) 同時插一筆 admin_today_sessions 並驗 GET /sessions/today 含之
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path B: 排課 + 體驗課簽到');
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');
  const today = new Date().toISOString().slice(0, 10);
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const enrollId = `e2e-B-enr-${Date.now()}`;
  const sessionId = `e2e-B-${Date.now()}`;
  try {
    await pg.query(
      `ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS experience_checked_in_at TIMESTAMPTZ`,
    );
    await pg.query(
      `INSERT INTO admin_enrollments
        (id, parent_name, parent_phone, students, coach, venue_id, course_type,
         original_price, final_price, transfer_last_5, status, submitted_at)
       VALUES ($1,'E2E家長B','0900000B01',ARRAY['學員B'],'王教練','B',1,3000,3000,'00000','confirmed',NOW())`,
      [enrollId],
    );
    await pg.query(
      `INSERT INTO admin_today_sessions (id, date, start_time, end_time, coach, students, venue_id, course_type)
       VALUES ($1,$2,'10:00','11:00','王教練',ARRAY['學員B']::text[],'B',1)`,
      [sessionId, today],
    );

    const list = await call('GET', '/api/admin/sessions/today', { token });
    assert(list.status === 200, `today 200，實際 ${list.status}`);
    assert(Array.isArray(list.data) && list.data.some((s) => String(s.id) === sessionId),
      '今日 sessions 含剛建立 session');

    const r = await call('POST', '/api/admin/sessions/checkin', {
      token, body: { enrollmentId: enrollId },
    });
    assert(r.status === 200, `checkin 200，實際 ${r.status}：${JSON.stringify(r.data).slice(0,200)}`);
    assert(r.data.ok === true, 'response.ok=true');

    const after = await pg.query(
      `SELECT experience_checked_in_at FROM admin_enrollments WHERE id=$1`,
      [enrollId],
    );
    assert(!!after.rows[0].experience_checked_in_at, 'experience_checked_in_at 已被寫入');

    const audit = await pg.query(
      `SELECT action FROM admin_enrollment_audit_logs WHERE enrollment_id=$1 AND action='體驗課簽到'`,
      [enrollId],
    );
    assert(audit.rowCount >= 1, 'audit log 含「體驗課簽到」一筆');
  } finally {
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id=$1`, [enrollId]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE id=$1`, [enrollId]);
    await pg.query(`DELETE FROM admin_today_sessions WHERE id=$1`, [sessionId]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
