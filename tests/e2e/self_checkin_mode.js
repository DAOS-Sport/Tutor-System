/*
 * U13 雙軌簽到整合測試（真實 routes + 真實 PostgreSQL，隔離資料、finally 清理）。
 *
 *  1. 預約制（預設）打自助簽到 → 409 SELF_CHECKIN_NOT_ENABLED（行為守恆）
 *  2. 後台單期切換 self（含 audit）→ 管理清單看得到模式
 *  3. 自助簽到 2 位小孩 → 一堂（1 session、2 checkins）、剩餘 5 堂
 *  4. 同日重複簽到 → 409 ALREADY_CHECKED_IN_TODAY（DB 唯一鍵硬擋）
 *  5. /courses/mine 卡片：checkin_mode='self'、self_checked_in_today=true、堂數 1/6
 *  6. 櫃檯撤銷 → 簽到移除、課堂取消、當日可重簽（名額釋放）
 *  7. 堂數用完 → 409 NO_SESSIONS_LEFT
 *  8. 非本家長學員 → 403；整館批次切換 → 生效
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signToken } = require('../../server/middlewares/adminAuth');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const checkinsRouter = require('../../server/routes/checkins');
const adminPeriodsRouter = require('../../server/routes/admin/periods');
const adminCheckinsRouter = require('../../server/routes/admin/checkins');
const coursesRouter = require('../../server/routes/courses');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/checkins', checkinsRouter);
  app.use('/api/admin/periods', adminPeriodsRouter);
  app.use('/api/admin/checkins', adminCheckinsRouter);
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
  step('U13 dual-mode checkin: 預約制守恆 / 自助簽到 / 每日一次 / 撤銷 / 堂數上限');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();

  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const venueId = `Y${suffix.slice(0, 3).toUpperCase()}`;
  const parentId = randomUUID();
  const strangerId = randomUUID();
  const coachId = randomUUID();
  const CT = 9401;
  const enrollmentId = `EU13${suffix.toUpperCase()}`;
  let periodId = null;

  try {
    await pg.query(`INSERT INTO venues (id, name, is_active) VALUES ($1, $2, TRUE)`, [venueId, `u13館${suffix}`]);
    await pg.query(
      `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active, pricing_multiplier)
       VALUES ($1, $2, $3, $4, TRUE, 1.00)`,
      [coachId, `u13教練${suffix}`, `0956${suffix.replace(/\D/g, '4').padEnd(6, '5').slice(0, 6)}`, `U13-${suffix}`]
    );
    await pg.query(`INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2)`, [coachId, venueId]);
    const parentPhone = `09${suffix.replace(/\D/g, '6').padEnd(8, '8').slice(0, 8)}`;
    await pg.query(
      `INSERT INTO parents (id, name, phone, line_uid, is_active) VALUES ($1, $2, $3, $4, TRUE)`,
      [parentId, `u13家長${suffix}`, parentPhone, `Uu13${suffix}${'0'.repeat(18)}`]
    );
    await pg.query(
      `INSERT INTO parents (id, name, phone, line_uid, is_active) VALUES ($1, $2, $3, $4, TRUE)`,
      [strangerId, `u13他家${suffix}`, `0933${suffix.replace(/\D/g, '9').padEnd(6, '1').slice(0, 6)}`, `Uu13x${suffix}${'0'.repeat(17)}`]
    );
    await pg.query(
      `INSERT INTO course_type_configs (course_type, label, min_students, max_students, sort_order, base_price, is_active)
       VALUES ($1, 'u13一對三', 1, 3, 993, 3000, TRUE)`,
      [CT]
    );
    const studentIds = [];
    for (const n of ['壹', '貳', '參']) {
      const r = await pg.query(`INSERT INTO students (parent_id, name) VALUES ($1, $2) RETURNING id`, [parentId, `u13${n}${suffix}`]);
      studentIds.push(r.rows[0].id);
    }
    const strangerStudent = await pg.query(
      `INSERT INTO students (parent_id, name) VALUES ($1, $2) RETURNING id`, [strangerId, `u13外人${suffix}`]
    );
    // anchor 報名單（/courses/mine 讀 admin_enrollments、audit 掛這裡）
    await pg.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
          original_price, final_price, status, submitted_at, period_count, period_number, total_sessions, used_sessions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,9000,9000,'confirmed',NOW(),1,1,6,0)`,
      [enrollmentId, `u13家長${suffix}`, parentPhone,
       ['壹', '貳', '參'].map((n) => `u13${n}${suffix}`), `u13教練${suffix}`, coachId, venueId, CT]
    );
    // 情境 1 的「預約制守恆」需要明確 booking（031 起全站預設已是 self）
    const p = await pg.query(
      `INSERT INTO course_periods
         (coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at,
          original_price, final_price, status, admin_enrollment_id, checkin_mode)
       VALUES ($1,$2,$3,6,0,(NOW() + interval '365 days')::date,9000,9000,'active',$4,'booking')
       RETURNING id`,
      [coachId, venueId, CT, enrollmentId]
    );
    periodId = p.rows[0].id;
    // 031 之後：未指定 checkin_mode 的新期別（對帳開通路徑）預設即為 self
    const defProbe = await pg.query(
      `INSERT INTO course_periods
         (coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at,
          original_price, final_price, status)
       VALUES ($1,$2,$3,6,0,(NOW() + interval '365 days')::date,0,0,'active')
       RETURNING id, checkin_mode`,
      [coachId, venueId, CT]
    );
    assert(defProbe.rows[0].checkin_mode === 'self', `新開課預設自助簽到，實際 ${defProbe.rows[0].checkin_mode}`);
    await pg.query(`DELETE FROM course_periods WHERE id = $1`, [defProbe.rows[0].id]);
    for (const sid of studentIds) {
      await pg.query(
        `INSERT INTO course_period_enrollments (course_period_id, student_id, status) VALUES ($1,$2,'active')`,
        [periodId, sid]
      );
    }

    const parentToken = signParentToken({ parentId, phone: parentPhone, lineUid: `Uu13${suffix}` });
    const adminToken = signToken({ sub: randomUUID(), username: 'u13-admin', name: 'u13-admin', role: 'admin' });

    // 1) 預約制（預設）→ 自助簽到被擋
    let r = await call(route.base, 'POST', '/api/checkins/self', {
      token: parentToken, body: { course_period_id: periodId, student_ids: studentIds.slice(0, 2) },
    });
    assert(r.status === 409 && r.data.code === 'SELF_CHECKIN_NOT_ENABLED',
      `預約制課程擋自助簽到，實際 ${r.status} ${r.data && r.data.code}`);

    // 2) 後台切換 self ＋ audit ＋ 管理清單
    r = await call(route.base, 'PATCH', `/api/admin/periods/${periodId}/checkin-mode`, {
      token: adminToken, body: { mode: 'self' },
    });
    assert(r.status === 200 && r.data.checkin_mode === 'self' && r.data.changed === true,
      `切換 self 成功，實際 ${r.status} ${JSON.stringify(r.data)}`);
    const audit = await pg.query(
      `SELECT COUNT(*)::int AS n FROM admin_enrollment_audit_logs WHERE enrollment_id = $1 AND action LIKE '切換簽到模式%'`,
      [enrollmentId]
    );
    assert(audit.rows[0].n === 1, `切換寫入 audit，實際 ${audit.rows[0].n} 筆`);
    r = await call(route.base, 'GET', `/api/admin/periods/checkin-modes?venueId=${venueId}`, { token: adminToken });
    assert(r.status === 200 && r.data.length === 1 && r.data[0].checkin_mode === 'self',
      `管理清單顯示 self 模式，實際 ${r.status} ${JSON.stringify(r.data && r.data[0] && r.data[0].checkin_mode)}`);

    // 3) 自助簽到 2 位小孩 → 一堂
    r = await call(route.base, 'POST', '/api/checkins/self', {
      token: parentToken, body: { course_period_id: periodId, student_ids: studentIds.slice(0, 2) },
    });
    assert(r.status === 201 && r.data.ok, `自助簽到成功，實際 ${r.status} ${JSON.stringify(r.data)}`);
    assert(r.data.used_sessions === 1 && r.data.remaining_sessions === 5,
      `簽到後 1/6（剩 5 堂），實際 ${r.data.used_sessions}/${r.data.remaining_sessions}`);
    const firstSessionId = r.data.session_id;
    const sess = await pg.query(
      `SELECT created_via, status::text AS status,
              (SELECT COUNT(*)::int FROM checkin_records cr WHERE cr.course_session_id = cs.id) AS checkins
         FROM course_sessions cs WHERE cs.id = $1`,
      [firstSessionId]
    );
    assert(sess.rows[0].created_via === 'self_checkin' && sess.rows[0].status === 'completed' && sess.rows[0].checkins === 2,
      `一堂 self 課堂＋2 筆簽到，實際 ${JSON.stringify(sess.rows[0])}`);

    // 4) 同日重複 → 409
    r = await call(route.base, 'POST', '/api/checkins/self', {
      token: parentToken, body: { course_period_id: periodId, student_ids: [studentIds[2]] },
    });
    assert(r.status === 409 && r.data.code === 'ALREADY_CHECKED_IN_TODAY',
      `同日重複簽到被擋，實際 ${r.status} ${r.data && r.data.code}`);

    // 5) /courses/mine 卡片狀態
    r = await call(route.base, 'GET', '/api/courses/mine', { token: parentToken });
    const card = (r.data || []).find((x) => x.course_period_id === periodId);
    assert(card && card.checkin_mode === 'self' && card.self_checked_in_today === true,
      `課程卡標示 self 模式＋今日已簽，實際 ${JSON.stringify(card && { m: card.checkin_mode, t: card.self_checked_in_today })}`);
    assert(card.used_sessions === 1 && card.remaining_sessions === 5,
      `課程卡堂數 1/6，實際 ${card.used_sessions}/${card.remaining_sessions}`);

    // 6) 櫃檯撤銷 → 可重簽（名額釋放、堂數歸還）
    r = await call(route.base, 'DELETE', `/api/admin/checkins/self-sessions/${firstSessionId}`, { token: adminToken });
    assert(r.status === 200 && r.data.removed_checkins === 2, `撤銷成功移除 2 筆簽到，實際 ${r.status} ${JSON.stringify(r.data)}`);
    const revoked = await pg.query(
      `SELECT status::text AS status, self_checkin_date FROM course_sessions WHERE id = $1`, [firstSessionId]
    );
    assert(revoked.rows[0].status === 'cancelled_normal' && revoked.rows[0].self_checkin_date === null,
      `課堂取消＋當日名額釋放，實際 ${JSON.stringify(revoked.rows[0])}`);
    r = await call(route.base, 'POST', '/api/checkins/self', {
      token: parentToken, body: { course_period_id: periodId, student_ids: studentIds },
    });
    assert(r.status === 201 && r.data.checked_in_students.length === 3 && r.data.remaining_sessions === 5,
      `撤銷後當日可重簽（3 位、剩 5 堂），實際 ${r.status} ${JSON.stringify(r.data && r.data.remaining_sessions)}`);

    // 7) 堂數用完 → 409。先把今天的簽到/課堂搬到昨天（否則「今日已簽」「簽進今日課堂」
    //    兩道過渡守門會先攔），再把 total_sessions 降到 1 → 非取消課堂 1 堂即滿。
    await pg.query(
      `DELETE FROM checkin_records WHERE course_session_id IN
         (SELECT id FROM course_sessions WHERE course_period_id = $1)`, [periodId]);
    await pg.query(
      `UPDATE course_sessions SET scheduled_at = NOW() - interval '1 day', self_checkin_date = NULL
        WHERE course_period_id = $1`, [periodId]);
    await pg.query(`UPDATE course_periods SET total_sessions = 1 WHERE id = $1`, [periodId]);
    r = await call(route.base, 'POST', '/api/checkins/self', {
      token: parentToken, body: { course_period_id: periodId, student_ids: [studentIds[0]] },
    });
    assert(r.status === 409 && r.data.code === 'NO_SESSIONS_LEFT',
      `堂數用完被擋，實際 ${r.status} ${r.data && r.data.code}`);
    await pg.query(`UPDATE course_periods SET total_sessions = 6 WHERE id = $1`, [periodId]);

    // 9) 過渡保護：今天已排「預約課堂」未簽到 → 自助簽到直接簽進那一堂（不另建）
    const booked = await pg.query(
      `INSERT INTO course_sessions (course_period_id, coach_id, scheduled_at, status)
       VALUES ($1, $2, NOW() + interval '1 hour', 'confirmed') RETURNING id`,
      [periodId, coachId]
    );
    const beforeCount = await pg.query(
      `SELECT COUNT(*)::int AS n FROM course_sessions WHERE course_period_id = $1`, [periodId]);
    r = await call(route.base, 'POST', '/api/checkins/self', {
      token: parentToken, body: { course_period_id: periodId, student_ids: [studentIds[0]] },
    });
    assert(r.status === 201 && r.data.reused_booked_session === true && r.data.session_id === booked.rows[0].id,
      `自助簽到簽進今日既有預約課堂，實際 ${r.status} ${JSON.stringify(r.data && { reused: r.data.reused_booked_session, same: r.data.session_id === booked.rows[0].id })}`);
    const afterCount = await pg.query(
      `SELECT COUNT(*)::int AS n FROM course_sessions WHERE course_period_id = $1`, [periodId]);
    assert(afterCount.rows[0].n === beforeCount.rows[0].n, `未另建課堂，實際 ${beforeCount.rows[0].n} → ${afterCount.rows[0].n}`);
    const bookedNow = await pg.query(`SELECT status::text AS status FROM course_sessions WHERE id = $1`, [booked.rows[0].id]);
    assert(bookedNow.rows[0].status === 'completed', `預約課堂轉 completed，實際 ${bookedNow.rows[0].status}`);

    // 10) 跨模式同日雙扣防護：今天已有簽到（上一步）→ 再自助簽到被擋
    r = await call(route.base, 'POST', '/api/checkins/self', {
      token: parentToken, body: { course_period_id: periodId, student_ids: [studentIds[1]] },
    });
    assert(r.status === 409 && r.data.code === 'ALREADY_CHECKED_IN_TODAY',
      `同日已有（預約課堂）簽到 → 自助簽到被擋，實際 ${r.status} ${r.data && r.data.code}`);

    // 8) 非本家長學員 → 403；整館批次切換
    r = await call(route.base, 'POST', '/api/checkins/self', {
      token: parentToken, body: { course_period_id: periodId, student_ids: [strangerStudent.rows[0].id] },
    });
    assert(r.status === 403 && r.data.code === 'STUDENT_NOT_IN_PERIOD',
      `他家學員被擋，實際 ${r.status} ${r.data && r.data.code}`);
    r = await call(route.base, 'POST', '/api/admin/periods/checkin-mode/bulk', {
      token: adminToken, body: { venue_id: venueId, mode: 'booking' },
    });
    assert(r.status === 200 && r.data.changed === 1, `整館批次切回預約制 1 期，實際 ${r.status} ${JSON.stringify(r.data)}`);
    const modeNow = await pg.query(`SELECT checkin_mode FROM course_periods WHERE id = $1`, [periodId]);
    assert(modeNow.rows[0].checkin_mode === 'booking', `批次切換生效，實際 ${modeNow.rows[0].checkin_mode}`);

    step('PASS: U13 雙軌簽到（守恆/切換/簽到/每日一次/撤銷/上限/越權/批次）全數通過');
  } finally {
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = $1`, [enrollmentId]).catch(() => {});
    if (periodId) await pg.query(`DELETE FROM course_periods WHERE id = $1`, [periodId]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE id = $1`, [enrollmentId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE parent_id IN ($1, $2)`, [parentId, strangerId]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id IN ($1, $2)`, [parentId, strangerId]).catch(() => {});
    await pg.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM coaches WHERE id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM course_type_configs WHERE course_type = $1`, [CT]).catch(() => {});
    await pg.query(`DELETE FROM venues WHERE id = $1`, [venueId]).catch(() => {});
    await route.close().catch(() => {});
    await pg.end().catch(() => {});
  }
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
