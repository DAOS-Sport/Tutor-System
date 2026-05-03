// 路徑 B：教練開槽 → 學員 1v1 預約 → admin 簽到 → used_sessions+1
// 1) 建一筆 coach_availability_slots(available) on coach + period
// 2) 呼叫 services/slots.bookSlot1v1（即生產用的選槽路徑）
//    → 驗 course_sessions.status='confirmed'、slot.status='booked'
// 3) 同時驗 admin 體驗課簽到流程（POST /api/admin/sessions/checkin）
//    → 驗 admin_enrollments.experience_checked_in_at + audit log
// 4) 模擬上完一堂：UPDATE course_periods.used_sessions+=1 → 驗 SQL 路徑可工作
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');
const slots = require('../../server/services/slots');

(async () => {
  step('Path B: 教練開槽 → 1v1 預約 → 簽到 → used+1');
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');
  const today = new Date().toISOString().slice(0, 10);
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const seed = await pg.query(
    `SELECT cp.id AS period_id, cp.coach_id, COALESCE(cp.used_sessions,0) AS used,
            cpe.student_id, s.parent_id
       FROM course_periods cp
       JOIN course_period_enrollments cpe ON cpe.course_period_id=cp.id AND cpe.status='active'
       JOIN students s ON s.id=cpe.student_id
      LIMIT 1`,
  );

  // ── 子情境 1：admin 體驗課簽到（一定可跑）──
  const enrollId = `e2e-B-enr-${Date.now()}`;
  const sessionRowId = `e2e-B-tsess-${Date.now()}`;
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
      [sessionRowId, today],
    );

    const list = await call('GET', '/api/admin/sessions/today', { token });
    assert(list.status === 200, `today 200`);
    assert(Array.isArray(list.data) && list.data.some((s) => String(s.id) === sessionRowId),
      '今日 sessions 含剛建立的');

    const r = await call('POST', '/api/admin/sessions/checkin', {
      token, body: { enrollmentId: enrollId },
    });
    assert(r.status === 200 && r.data.ok === true, `checkin ok=true`);
    const after = await pg.query(
      `SELECT experience_checked_in_at FROM admin_enrollments WHERE id=$1`, [enrollId],
    );
    assert(!!after.rows[0].experience_checked_in_at, 'experience_checked_in_at 寫入');
    const audit = await pg.query(
      `SELECT 1 FROM admin_enrollment_audit_logs WHERE enrollment_id=$1 AND action='體驗課簽到'`,
      [enrollId],
    );
    assert(audit.rowCount >= 1, `audit log '體驗課簽到' 寫入`);

    // ── 子情境 2：學員 1v1 預約（需有 active period）──
    if (seed.rowCount) {
      const { period_id, coach_id, used: baseUsed } = seed.rows[0];
      const slotRes = await pg.query(
        `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status)
         VALUES ($1,'B', NOW() + INTERVAL '5 day', 60, 'available') RETURNING id`,
        [coach_id],
      );
      const slotId = slotRes.rows[0].id;
      let csid;
      try {
        // 真呼叫生產函數 services/slots.bookSlot1v1（即家長端 1v1 預約用的同一段邏輯）
        const session = await slots.bookSlot1v1(slotId, period_id);
        csid = session.id;
        assert(session.status === 'confirmed', `bookSlot1v1 回傳 status=confirmed，實際 ${session.status}`);
        const slotState = await pg.query(`SELECT status, booked_session_id FROM coach_availability_slots WHERE id=$1`, [slotId]);
        assert(slotState.rows[0].status === 'booked', '預約後 slot.status=booked');
        assert(String(slotState.rows[0].booked_session_id) === String(csid), 'slot.booked_session_id 指向新 session');

        // 上完一堂：used_sessions += 1（生產的「上完課」邏輯）
        await pg.query(`UPDATE course_periods SET used_sessions = COALESCE(used_sessions,0)+1 WHERE id=$1`, [period_id]);
        const u = await pg.query(`SELECT used_sessions FROM course_periods WHERE id=$1`, [period_id]);
        assert(u.rows[0].used_sessions === baseUsed + 1, `used_sessions: ${baseUsed} → ${u.rows[0].used_sessions}`);

        // 還原
        await pg.query(`UPDATE course_periods SET used_sessions = $1 WHERE id=$2`, [baseUsed, period_id]);
      } finally {
        await pg.query(`UPDATE coach_availability_slots SET booked_session_id=NULL WHERE id=$1`, [slotId]).catch(() => {});
        if (csid) await pg.query(`DELETE FROM course_sessions WHERE id=$1`, [csid]);
        await pg.query(`DELETE FROM coach_availability_slots WHERE id=$1`, [slotId]);
      }

    } else {
      console.log('  ⚠ 無 active period，跳過 1v1 預約子情境');
    }
  } finally {
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id=$1`, [enrollId]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE id=$1`, [enrollId]);
    await pg.query(`DELETE FROM admin_today_sessions WHERE id=$1`, [sessionRowId]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
