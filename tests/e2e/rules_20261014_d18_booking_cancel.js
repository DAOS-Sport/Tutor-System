/*
 * D18（GitHub Tutor-System #13）兩個高嚴重度缺口 e2e（in-process 掛 router、拋棄式 PostgreSQL、finally 清理）：
 *   S 家長預約：已過去的時段一律擋下（SLOT_IN_PAST），不建課堂、時段維持 available；未來時段照常成立。
 *   K 整組報名取消：一對二取消其中一位＝同批同期兄弟訂單一起取消，其他期不動；
 *     已被一起取消的那筆再取消回成功；家長端並發逐筆取消同一期不死結、都成功；
 *     同期有已對帳的兄弟就整筆擋下（NOT_PENDING）、什麼都不改；一對一照舊只取消那一筆；
 *     同批同期混到別的購買人就整筆擋下（BATCH_MIXED_BUYERS），不替別人取消。
 *   E 家長預約：課期已過期一律擋下（PERIOD_EXPIRED）；到期日當天仍可（與自助簽到同一判準）。
 *   R 回歸防線：K8 點到已退費的那一筆要擋（改版前本來就擋，防止新取消邏輯回歸）。
 *   D18_PART=S、E、K 或 R 只跑該段（預設全部），用來在改版前分別證明各個缺口。
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const slotsRouter = require('../../server/routes/slots');
const coursesRouter = require('../../server/routes/courses');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/slots', slotsRouter);
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

async function call(base, method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const phone = `09${String(parseInt(suffix.slice(0, 8), 16)).padStart(8, '0').slice(-8)}`;
  const parentId = randomUUID();
  const enrollmentIds = [];
  let periodId = null;
  const slotIds = [];

  try {
    const reference = await pg.query(
      `SELECT c.id AS coach_id, c.name AS coach_name, v.id AS venue_id
         FROM coaches c CROSS JOIN venues v
        WHERE c.is_active = TRUE AND COALESCE(c.is_placeholder, FALSE) = FALSE AND v.is_active = TRUE
        ORDER BY c.created_at, v.id LIMIT 1`
    );
    if (!reference.rowCount) throw new Error('test database needs one active non-placeholder coach and venue');
    const { coach_id: coachId, coach_name: coachName, venue_id: venueId } = reference.rows[0];

    await pg.query(`INSERT INTO parents (id, phone, name, line_uid, is_active) VALUES ($1,$2,$3,$4,TRUE)`,
      [parentId, phone, `E2E D18 家長 ${suffix}`, `e2ed18_${suffix}`]);
    const kidA = (await pg.query(`INSERT INTO students (parent_id, name, is_active) VALUES ($1,$2,TRUE) RETURNING id`,
      [parentId, `D18甲${suffix}`])).rows[0].id;
    const kidB = (await pg.query(`INSERT INTO students (parent_id, name, is_active) VALUES ($1,$2,TRUE) RETURNING id`,
      [parentId, `D18乙${suffix}`])).rows[0].id;
    const token = signParentToken({ parentId, phone });

    const part = String(process.env.D18_PART || 'all').toUpperCase();
    const runs = (p) => part === 'ALL' || part === p;
    const order = async ({ courseType, batchId, periodNumber, kid, kidName, status = 'pending_payment', buyerPhone = phone }) => {
      const id = `ED18${suffix}${String(enrollmentIds.length).padStart(2, '0')}`.toUpperCase();
      enrollmentIds.push(id);
      await pg.query(
        `INSERT INTO admin_enrollments
           (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
            original_price, final_price, status, submitted_at, period_count, period_number,
            enrollment_batch_id, order_kind, total_sessions, used_sessions, student_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1000,1000,$9,NOW(),1,$10,$11,'standard',4,0,$12)`,
        [id, `E2E D18 家長 ${suffix}`, buyerPhone, [kidName], coachName, coachId, venueId, courseType,
          status, periodNumber, batchId, [kid]]
      );
      return id;
    };
    const statusOf = async (ids) => (await pg.query(
      `SELECT id, status FROM admin_enrollments WHERE id = ANY($1::text[]) ORDER BY id`, [ids])).rows
      .map((r) => r.status);

    // ───────────────────── 預約用課期與時段（S、E 共用）─────────────────────
    let slot = null;
    if (runs('S') || runs('E')) {
      const srcId = await order({ courseType: 1, batchId: null, periodNumber: 1, kid: kidA, kidName: `D18甲${suffix}`, status: 'confirmed' });
      periodId = (await pg.query(
        `INSERT INTO course_periods (coach_id, venue_id, course_type, total_sessions, used_sessions, status,
                                     original_price, final_price, expires_at, admin_enrollment_id)
         VALUES ($1,$2,1,4,0,'active',1000,1000,CURRENT_DATE + 60,$3) RETURNING id`,
        [coachId, venueId, srcId])).rows[0].id;
      await pg.query(`INSERT INTO course_period_enrollments (course_period_id, student_id, status) VALUES ($1,$2,'active')`,
        [periodId, kidA]);
      slot = async (interval) => {
        const id = (await pg.query(
          `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status)
           VALUES ($1,$2,NOW() + $3::interval,60,'available') RETURNING id`, [coachId, venueId, interval])).rows[0].id;
        slotIds.push(id);
        return id;
      };
    }

    // ───────────────────────── S 家長預約時段 ─────────────────────────
    if (runs('S')) {
      step('S1 已過去的時段（3 天前）→ 擋下 SLOT_IN_PAST，不建課堂、時段仍 available');
      const pastSlot = await slot('-3 days');
      const past = await call(route.base, 'POST', `/api/slots/${pastSlot}/book`, token, { course_period_id: periodId });
      assert(past.status === 409 && past.data?.code === 'SLOT_IN_PAST', `過去時段被擋（${past.status} ${past.data?.code}）`);
      const pastState = (await pg.query(`SELECT status FROM coach_availability_slots WHERE id = $1`, [pastSlot])).rows[0].status;
      const pastSessions = (await pg.query(`SELECT COUNT(*)::int AS n FROM course_sessions WHERE availability_slot_id = $1`, [pastSlot])).rows[0].n;
      assert(pastState === 'available' && pastSessions === 0, `時段仍 available、沒建課堂（${pastState}／${pastSessions}）`);

      step('S2 已開始 10 分鐘的時段 → 同樣擋下');
      const startedSlot = await slot('-10 minutes');
      const started = await call(route.base, 'POST', `/api/slots/${startedSlot}/book`, token, { course_period_id: periodId });
      assert(started.status === 409 && started.data?.code === 'SLOT_IN_PAST', `已開始時段被擋（${started.status} ${started.data?.code}）`);

      step('S3 未來時段（2 天後）→ 照常成立 confirmed');
      const futureSlot = await slot('2 days');
      const future = await call(route.base, 'POST', `/api/slots/${futureSlot}/book`, token, { course_period_id: periodId });
      assert(future.status === 201 && future.data?.session?.status === 'confirmed', `未來時段預約成功（${future.status} ${JSON.stringify(future.data).slice(0, 120)}）`);
    }

    // ───────────────────────── E 過期課期預約 ─────────────────────────
    if (runs('E')) {
      step('E1 課期昨天到期 → 擋下 PERIOD_EXPIRED，不建課堂、時段仍 available');
      await pg.query(`UPDATE course_periods SET expires_at = CURRENT_DATE - 1 WHERE id = $1`, [periodId]);
      const expiredSlot = await slot('3 days');
      const expired = await call(route.base, 'POST', `/api/slots/${expiredSlot}/book`, token, { course_period_id: periodId });
      assert(expired.status === 409 && expired.data?.code === 'PERIOD_EXPIRED', `過期課期被擋（${expired.status} ${expired.data?.code}）`);
      const expiredState = (await pg.query(`SELECT status FROM coach_availability_slots WHERE id = $1`, [expiredSlot])).rows[0].status;
      const expiredSessions = (await pg.query(`SELECT COUNT(*)::int AS n FROM course_sessions WHERE availability_slot_id = $1`, [expiredSlot])).rows[0].n;
      assert(expiredState === 'available' && expiredSessions === 0, `時段仍 available、沒建課堂（${expiredState}／${expiredSessions}）`);

      step('E2 課期今天到期 → 當天仍可預約（與自助簽到同一判準）');
      await pg.query(`UPDATE course_periods SET expires_at = CURRENT_DATE WHERE id = $1`, [periodId]);
      const lastDaySlot = await slot('1 hour');
      const lastDay = await call(route.base, 'POST', `/api/slots/${lastDaySlot}/book`, token, { course_period_id: periodId });
      assert(lastDay.status === 201, `到期日當天預約成功（${lastDay.status} ${lastDay.data?.code || ''}）`);
      await pg.query(`UPDATE course_periods SET expires_at = CURRENT_DATE + 60 WHERE id = $1`, [periodId]);
    }

    // ───────────────────────── K 整組報名取消 ─────────────────────────
    if (runs('K')) {
      step('K1 一對二 2 位 × 2 期：取消第 1 期其中一位 → 第 1 期兩位一起取消，第 2 期不動');
      const batch = randomUUID();
      const p1a = await order({ courseType: 2, batchId: batch, periodNumber: 1, kid: kidA, kidName: `D18甲${suffix}` });
      const p1b = await order({ courseType: 2, batchId: batch, periodNumber: 1, kid: kidB, kidName: `D18乙${suffix}` });
      const p2a = await order({ courseType: 2, batchId: batch, periodNumber: 2, kid: kidA, kidName: `D18甲${suffix}` });
      const p2b = await order({ courseType: 2, batchId: batch, periodNumber: 2, kid: kidB, kidName: `D18乙${suffix}` });
      const k1 = await call(route.base, 'POST', `/api/courses/${p1a}/cancel`, token);
      assert(k1.status === 200 && k1.data?.ok === true, `取消成功（${k1.status} ${JSON.stringify(k1.data)}）`);
      assert((await statusOf([p1a, p1b])).every((s) => s === 'cancelled'), '第 1 期兩位都取消');
      assert((await statusOf([p2a, p2b])).every((s) => s === 'pending_payment'), '第 2 期兩位仍待付款');
      const audits = (await pg.query(`SELECT COUNT(*)::int AS n FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`,
        [[p1a, p1b]])).rows[0].n;
      assert(audits === 2, `兩筆都有取消紀錄（${audits}）`);

      step('K2 再取消已被一起取消的那位 → 回成功（already_cancelled），不回「已進入處理流程」');
      const k2 = await call(route.base, 'POST', `/api/courses/${p1b}/cancel`, token);
      assert(k2.status === 200 && k2.data?.already_cancelled === true, `已取消回成功（${k2.status} ${JSON.stringify(k2.data)}）`);

      step('K3 並發逐筆取消第 2 期兩位（同「我的課程」Promise.all）→ 都成功、不死結、兩位都取消');
      const [c1, c2] = await Promise.all([
        call(route.base, 'POST', `/api/courses/${p2a}/cancel`, token),
        call(route.base, 'POST', `/api/courses/${p2b}/cancel`, token),
      ]);
      assert(c1.status === 200 && c2.status === 200, `兩個請求都 200（${c1.status}／${c2.status}）`);
      assert((await statusOf([p2a, p2b])).every((s) => s === 'cancelled'), '第 2 期兩位都取消');

      step('K4 同期有已對帳的兄弟 → 擋下 NOT_PENDING，什麼都不改');
      const batch2 = randomUUID();
      const q1 = await order({ courseType: 2, batchId: batch2, periodNumber: 1, kid: kidA, kidName: `D18甲${suffix}` });
      const q2 = await order({ courseType: 2, batchId: batch2, periodNumber: 1, kid: kidB, kidName: `D18乙${suffix}`, status: 'confirmed' });
      const k4 = await call(route.base, 'POST', `/api/courses/${q1}/cancel`, token);
      assert(k4.status === 409 && k4.data?.code === 'NOT_PENDING', `被擋（${k4.status} ${k4.data?.code}）`);
      assert((await statusOf([q1, q2])).join() === 'pending_payment,confirmed', '兩筆狀態不變');

      step('K5 一對一 2 期：取消第 1 期 → 只取消那一筆（行為不變）');
      const batch3 = randomUUID();
      const s1 = await order({ courseType: 1, batchId: batch3, periodNumber: 1, kid: kidA, kidName: `D18甲${suffix}` });
      const s2 = await order({ courseType: 1, batchId: batch3, periodNumber: 2, kid: kidA, kidName: `D18甲${suffix}` });
      const k5 = await call(route.base, 'POST', `/api/courses/${s1}/cancel`, token);
      assert(k5.status === 200, `取消成功（${k5.status}）`);
      assert((await statusOf([s1, s2])).join() === 'cancelled,pending_payment', '只取消第 1 期');

      step('K6 一對二同期只剩一位的舊單（歷史上本來就不滿）→ 只取消那一筆，照舊');
      const batch4 = randomUUID();
      const lone = await order({ courseType: 2, batchId: batch4, periodNumber: 1, kid: kidA, kidName: `D18甲${suffix}` });
      const k6 = await call(route.base, 'POST', `/api/courses/${lone}/cancel`, token);
      assert(k6.status === 200 && (await statusOf([lone]))[0] === 'cancelled', `舊單取消成功（${k6.status}）`);

      step('K7 同批同期混到別的購買人 → 擋下 BATCH_MIXED_BUYERS，兩筆都不動');
      const batch5 = randomUUID();
      const mine = await order({ courseType: 2, batchId: batch5, periodNumber: 1, kid: kidA, kidName: `D18甲${suffix}` });
      const other = await order({ courseType: 2, batchId: batch5, periodNumber: 1, kid: kidB, kidName: `D18乙${suffix}`,
        buyerPhone: `08${phone.slice(2)}` });
      const k7 = await call(route.base, 'POST', `/api/courses/${mine}/cancel`, token);
      assert(k7.status === 409 && k7.data?.code === 'BATCH_MIXED_BUYERS', `被擋（${k7.status} ${k7.data?.code}）`);
      assert((await statusOf([mine, other])).every((s) => s === 'pending_payment'), '兩筆都仍待付款');
    }

    // ───────────────── R 回歸防線（改版前也應通過：舊版對已退費一律回 409）─────────────────
    if (runs('R')) {
      step('K8 點到已退費的那一筆 → 擋下 NOT_PENDING；同期兩筆都退費、或另一筆待付款，都不會被動到');
      const batch6 = randomUUID();
      const r1 = await order({ courseType: 2, batchId: batch6, periodNumber: 1, kid: kidA, kidName: `D18甲${suffix}`, status: 'refunded' });
      const r2 = await order({ courseType: 2, batchId: batch6, periodNumber: 1, kid: kidB, kidName: `D18乙${suffix}`, status: 'refunded' });
      const k8a = await call(route.base, 'POST', `/api/courses/${r1}/cancel`, token);
      assert(k8a.status === 409 && k8a.data?.code === 'NOT_PENDING', `兩筆都退費時被擋（${k8a.status} ${k8a.data?.code}）`);
      assert((await statusOf([r1, r2])).join() === 'refunded,refunded', '兩筆仍是已退費');
      const batch7 = randomUUID();
      const rf = await order({ courseType: 2, batchId: batch7, periodNumber: 1, kid: kidA, kidName: `D18甲${suffix}`, status: 'refunded' });
      const pd = await order({ courseType: 2, batchId: batch7, periodNumber: 1, kid: kidB, kidName: `D18乙${suffix}` });
      const k8b = await call(route.base, 'POST', `/api/courses/${rf}/cancel`, token);
      assert(k8b.status === 409 && k8b.data?.code === 'NOT_PENDING', `點已退費那筆被擋（${k8b.status} ${k8b.data?.code}）`);
      assert((await statusOf([rf, pd])).join() === 'refunded,pending_payment', '待付款的兄弟沒被取消');
    }
  } finally {
    if (slotIds.length) {
      await pg.query(`UPDATE coach_availability_slots SET booked_session_id = NULL WHERE id = ANY($1::uuid[])`, [slotIds]).catch(() => {});
      await pg.query(`DELETE FROM course_sessions WHERE availability_slot_id = ANY($1::uuid[])`, [slotIds]).catch(() => {});
      await pg.query(`DELETE FROM coach_availability_slots WHERE id = ANY($1::uuid[])`, [slotIds]).catch(() => {});
    }
    if (periodId) {
      await pg.query(`DELETE FROM course_period_enrollments WHERE course_period_id = $1`, [periodId]).catch(() => {});
      await pg.query(`DELETE FROM course_periods WHERE id = $1`, [periodId]).catch(() => {});
    }
    if (enrollmentIds.length) {
      await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
      await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    }
    await pg.query(`DELETE FROM students WHERE parent_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = $1`, [parentId]).catch(() => {});
    await pg.end();
    await route.close();
    const { pool } = require('../../server/models/db');
    await pool.end().catch(() => {});
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
