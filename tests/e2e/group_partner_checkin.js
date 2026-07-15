/*
 * 團報跨家庭共享簽到整合測試（真實 routes + 真實 PostgreSQL）。
 *
 *  A 家長替同一堂簽到：
 *    - 同一共享 period 的完整 active roster 都建立 attendance，但只扣 1 堂。
 *    - B 家長的逐堂清單與課程卡顯示「團報夥伴王媽媽已代為簽到」。
 *    - A 自己不會看到自己被標成團報夥伴，API 也不回傳對方全名／parent id。
 *  下一堂由 B 簽到時方向相反，A 顯示「團報夥伴李爸爸已代為簽到」。
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signParentToken } = require('../../server/middlewares/parentAuth');

const previousFlag = process.env.SHARED_CHECKIN_USAGE_V2;
// 刻意移除測試／shell 環境覆寫：本測試必須驗證 migration/bootstrap 寫入資料庫的
// production 全量旗標即可啟用功能，避免只在測試 process 裡看似成功。
delete process.env.SHARED_CHECKIN_USAGE_V2;
const checkinsRouter = require('../../server/routes/checkins');
const coursesRouter = require('../../server/routes/courses');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/checkins', checkinsRouter);
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
  step('Group partner checkin: A/B 家庭共享一堂、互見代簽稱謂、堂數只扣一次');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();

  const productionFlag = await pg.query(
    `SELECT enabled, allowed_phones
       FROM application_feature_flags
      WHERE key = 'SHARED_CHECKIN_USAGE_V2'`
  );
  assert(
    productionFlag.rows[0]?.enabled === true
      && (productionFlag.rows[0]?.allowed_phones || []).length === 0,
    '未設定 SHARED_CHECKIN_USAGE_V2 env 時，資料庫正式旗標仍為全量啟用'
  );

  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const venueId = `GP${suffix.slice(0, 6).toUpperCase()}`;
  const parentA = randomUUID();
  const parentB = randomUUID();
  const coachId = randomUUID();
  const groupOrderId = randomUUID();
  const enrollmentA = `EGPA${suffix.toUpperCase()}`;
  const enrollmentB = `EGPB${suffix.toUpperCase()}`;
  const phoneDigits = String(parseInt(suffix, 16)).padStart(10, '0').slice(-8);
  const phoneDigitsB = String((Number(phoneDigits) + 1) % 100000000).padStart(8, '0');
  const phoneA = `09${phoneDigits}`;
  const phoneB = `09${phoneDigitsB}`;
  const CT = 9501;
  let periodId = null;
  let studentA = null;
  let studentB = null;

  try {
    await pg.query(`INSERT INTO venues (id, name, is_active) VALUES ($1, $2, TRUE)`, [venueId, `團報測試館${suffix}`]);
    await pg.query(
      `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active, pricing_multiplier)
       VALUES ($1, $2, $3, $4, TRUE, 1.00)`,
      [coachId, `團報教練${suffix}`, `07${phoneDigits}`, `GP-${suffix}`]
    );
    await pg.query(`INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2)`, [coachId, venueId]);
    await pg.query(
      `INSERT INTO parents (id, name, phone, line_uid, gender, is_active)
       VALUES ($1, '王小華', $2, $3, '生理女', TRUE),
              ($4, '李大明', $5, $6, '生理男', TRUE)`,
      [parentA, phoneA, `UGPA${suffix}`, parentB, phoneB, `UGPB${suffix}`]
    );
    const students = await pg.query(
      `INSERT INTO students (parent_id, name)
       VALUES ($1, $2), ($3, $4)
       RETURNING id, parent_id`,
      [parentA, `王寶${suffix}`, parentB, `李寶${suffix}`]
    );
    studentA = students.rows.find((row) => row.parent_id === parentA).id;
    studentB = students.rows.find((row) => row.parent_id === parentB).id;
    await pg.query(
      `INSERT INTO course_type_configs
         (course_type, label, min_students, max_students, sort_order, base_price, is_active)
       VALUES ($1, '團報一對二測試', 2, 2, 995, 4500, TRUE)`,
      [CT]
    );
    await pg.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
          original_price, final_price, status, submitted_at, total_sessions, used_sessions,
          group_order_id, is_group_shared, period_count, period_number)
       VALUES ($1, '王小華', $2, $3, $4, $5, $6, $7, 4500, 4500, 'confirmed', NOW(), 6, 0, $8, TRUE, 1, 1),
              ($9, '李大明', $10, $11, $4, $5, $6, $7, 4500, 4500, 'confirmed', NOW(), 6, 0, $8, TRUE, 1, 1)`,
      [
        enrollmentA, phoneA, [`王寶${suffix}`], `團報教練${suffix}`, coachId, venueId, CT, groupOrderId,
        enrollmentB, phoneB, [`李寶${suffix}`],
      ]
    );
    const period = await pg.query(
      `INSERT INTO course_periods
         (coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at,
          original_price, final_price, status, admin_enrollment_id, group_order_id,
          period_number, checkin_mode)
       VALUES ($1,$2,$3,6,0,(NOW() + interval '365 days')::date,9000,9000,'active',$4,$5,1,'booking')
       RETURNING id`,
      [coachId, venueId, CT, enrollmentA, groupOrderId]
    );
    periodId = period.rows[0].id;
    await pg.query(
      `INSERT INTO course_period_enrollments (course_period_id, student_id, status)
       VALUES ($1,$2,'active'), ($1,$3,'active')`,
      [periodId, studentA, studentB]
    );
    const firstSession = await pg.query(
      `INSERT INTO course_sessions (course_period_id, coach_id, scheduled_at, status)
       VALUES ($1,$2,NOW(),'confirmed') RETURNING id`,
      [periodId, coachId]
    );

    const tokenA = signParentToken({ parentId: parentA, phone: phoneA, lineUid: `UGPA${suffix}` });
    const tokenB = signParentToken({ parentId: parentB, phone: phoneB, lineUid: `UGPB${suffix}` });

    let r = await call(route.base, 'POST', '/api/checkins', {
      token: tokenA,
      body: { sessionId: firstSession.rows[0].id, studentId: studentA },
    });
    assert(r.status === 200 && r.data.ok, `A 家長簽到成功，實際 ${r.status} ${JSON.stringify(r.data)}`);
    let attendance = await pg.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(DISTINCT checked_in_by_parent_id)::int AS authors,
              MIN(checked_in_by_parent_id::text) AS author
         FROM checkin_records
        WHERE course_session_id = $1 AND attendance_status = 'ATTENDED'`,
      [firstSession.rows[0].id]
    );
    assert(attendance.rows[0].n === 2, `A 一次操作替完整 2 人 roster 建 attendance，實際 ${attendance.rows[0].n}`);
    assert(attendance.rows[0].authors === 1 && attendance.rows[0].author === parentA,
      '兩筆 attendance 都保留 A 家長為代簽者');
    const usage = await pg.query(
      `SELECT cp.used_sessions,
              (SELECT COUNT(DISTINCT cr.course_session_id)::int
                 FROM checkin_records cr JOIN course_sessions cs ON cs.id = cr.course_session_id
                WHERE cs.course_period_id = cp.id AND cr.attendance_status = 'ATTENDED') AS actual_used,
              (SELECT array_agg(DISTINCT used_sessions ORDER BY used_sessions)
                 FROM admin_enrollments WHERE group_order_id = $2 AND period_number = 1) AS enrollment_used
         FROM course_periods cp WHERE cp.id = $1`,
      [periodId, groupOrderId]
    );
    assert(usage.rows[0].used_sessions === 1 && usage.rows[0].actual_used === 1,
      `同堂 2 人只扣共享池 1 堂，實際 stored/actual=${usage.rows[0].used_sessions}/${usage.rows[0].actual_used}`);
    assert((usage.rows[0].enrollment_used || []).join(',') === '1', 'A/B 兩戶訂單的 used_sessions 同步為 1');

    r = await call(route.base, 'GET', '/api/courses/lessons', { token: tokenB });
    const bFirst = (r.data || []).find((row) => row.session_id === firstSession.rows[0].id && row.student_id === studentB);
    assert(r.status === 200 && bFirst?.checked_in_at, 'B 家長看到同一堂已完成簽到');
    assert(bFirst.partner_checkin_label === '團報夥伴王媽媽',
      `B 看到「團報夥伴王媽媽」，實際 ${bFirst?.partner_checkin_label}`);
    assert(!Object.hasOwn(bFirst, 'partner_name') && !Object.hasOwn(bFirst, 'checked_in_by_parent_id'),
      '跨家庭 API 只回稱謂，不回對方全名或 parent id');

    r = await call(route.base, 'GET', '/api/courses/lessons', { token: tokenA });
    const aFirst = (r.data || []).find((row) => row.session_id === firstSession.rows[0].id && row.student_id === studentA);
    assert(aFirst?.partner_checkin_label == null, 'A 自己簽到不會把自己標成團報夥伴');

    r = await call(route.base, 'GET', '/api/courses/mine', { token: tokenB });
    const bCard = (r.data || []).find((row) => row.course_period_id === periodId);
    assert(bCard?.partner_checkin_label === '團報夥伴王媽媽',
      `B 的課程卡同步顯示代簽者，實際 ${bCard?.partner_checkin_label}`);
    assert(bCard?.used_sessions === 1 && bCard?.remaining_sessions === 5,
      `B 的共享堂數進度為 1/6，實際 ${bCard?.used_sessions}/${bCard?.remaining_sessions}`);

    // 同堂由 B 重按是冪等讀取，不能改寫原始代簽者。
    r = await call(route.base, 'POST', '/api/checkins', {
      token: tokenB,
      body: { sessionId: firstSession.rows[0].id, studentId: studentB },
    });
    assert(r.status === 200 && r.data.ok, 'B 對已代簽課堂重按仍為冪等成功');
    attendance = await pg.query(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT checked_in_by_parent_id)::int AS authors,
              MIN(checked_in_by_parent_id::text) AS author
         FROM checkin_records WHERE course_session_id = $1`,
      [firstSession.rows[0].id]
    );
    assert(attendance.rows[0].n === 2 && attendance.rows[0].authors === 1 && attendance.rows[0].author === parentA,
      '重按不新增 attendance、也不覆寫 A 的代簽身分');

    // 下一堂改由 B 先簽，A 應看到李爸爸。
    const secondSession = await pg.query(
      `INSERT INTO course_sessions (course_period_id, coach_id, scheduled_at, status)
       VALUES ($1,$2,NOW() + interval '1 minute','confirmed') RETURNING id`,
      [periodId, coachId]
    );
    r = await call(route.base, 'POST', '/api/checkins', {
      token: tokenB,
      body: { sessionId: secondSession.rows[0].id, studentId: studentB },
    });
    assert(r.status === 200 && r.data.ok, '第二堂由 B 家長簽到成功');
    r = await call(route.base, 'GET', '/api/courses/lessons', { token: tokenA });
    const aSecond = (r.data || []).find((row) => row.session_id === secondSession.rows[0].id && row.student_id === studentA);
    assert(aSecond?.partner_checkin_label === '團報夥伴李爸爸',
      `A 看到「團報夥伴李爸爸」，實際 ${aSecond?.partner_checkin_label}`);
    const finalUsage = await pg.query(`SELECT used_sessions FROM course_periods WHERE id = $1`, [periodId]);
    assert(finalUsage.rows[0].used_sessions === 2, `兩堂各扣一次，最後 used_sessions=2，實際 ${finalUsage.rows[0].used_sessions}`);

    step('PASS: 團報 A/B 共享簽到、雙向代簽提示、隱私與單堂單扣皆通過');
  } finally {
    if (periodId) await pg.query(`DELETE FROM course_periods WHERE id = $1`, [periodId]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE id IN ($1, $2)`, [enrollmentA, enrollmentB]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE parent_id IN ($1, $2)`, [parentA, parentB]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id IN ($1, $2)`, [parentA, parentB]).catch(() => {});
    await pg.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM coaches WHERE id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM course_type_configs WHERE course_type = $1`, [CT]).catch(() => {});
    await pg.query(`DELETE FROM venues WHERE id = $1`, [venueId]).catch(() => {});
    await route.close().catch(() => {});
    await pg.end().catch(() => {});
    if (previousFlag === undefined) delete process.env.SHARED_CHECKIN_USAGE_V2;
    else process.env.SHARED_CHECKIN_USAGE_V2 = previousFlag;
  }
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
