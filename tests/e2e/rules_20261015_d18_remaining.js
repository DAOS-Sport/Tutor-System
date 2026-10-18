/*
 * D18（GitHub Tutor-System #13）第二批缺口 e2e（in-process 掛 router／直接呼叫 service、拋棄式 PostgreSQL、finally 清理）：
 *   P 個人報名一對五：只選 3 位擋下（STUDENT_COUNT_MUST_MATCH_COURSE_TYPE），選滿 5 位照常成立。
 *   G 團購：教練停用時不能發起（COACH_INACTIVE）；組別停用或教練停用後不能再加入；條件恢復後可加入。
 *   T 轉讓申請：同一學員同一課期同時送兩次，只成立一筆（另一筆 409）；過期課期不可申請（PERIOD_EXPIRED）。
 *   V 評價：同一份評價同時送兩次，只有一次生效（另一次 409），分數是生效那次的。
 *   D18_PART=P、G、T 或 V 只跑該段（預設全部），用來在改版前分別證明各個缺口。
 * 測試期間會暫時調整拋棄式庫的組別與教練狀態，finally 一律還原。
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const enrollmentRouter = require('../../server/routes/enrollments');
const groupOrdersRouter = require('../../server/routes/groupOrders');
const transfers = require('../../server/services/transfers');
const evaluations = require('../../server/services/evaluations');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/group-orders', groupOrdersRouter);
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

async function call(base, method, path, token, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
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
  const part = String(process.env.D18_PART || 'all').toUpperCase();
  const runs = (p) => part === 'ALL' || part === p;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const digits = (n) => String(parseInt(suffix.slice(0, 8), 16) + n).padStart(8, '0').slice(-8);
  const parentId = randomUUID();
  const leaderId = randomUUID();
  const phone = `09${digits(0)}`;
  const leaderPhone = `09${digits(1)}`;
  const restore = [];
  const periodIds = [];
  const groupIds = [];
  const evalIds = [];

  try {
    const reference = await pg.query(
      `SELECT c.id AS coach_id, v.id AS venue_id, v.pricing_zone_id AS zone_id
         FROM coaches c CROSS JOIN venues v
        WHERE c.is_active = TRUE AND COALESCE(c.is_placeholder, FALSE) = FALSE AND v.is_active = TRUE
        ORDER BY c.created_at, v.id LIMIT 1`
    );
    if (!reference.rowCount) throw new Error('test database needs one active non-placeholder coach and venue');
    const { coach_id: coachId, venue_id: venueId, zone_id: zoneId } = reference.rows[0];

    await pg.query(`INSERT INTO parents (id, phone, name, line_uid, is_active) VALUES ($1,$2,$3,$4,TRUE),($5,$6,$7,$8,TRUE)`,
      [parentId, phone, `E2E D18b 家長 ${suffix}`, `e2ed18b_${suffix}`, leaderId, leaderPhone, `E2E D18b 團主 ${suffix}`, `e2ed18bl_${suffix}`]);
    const kids = [];
    for (let i = 0; i < 5; i += 1) {
      kids.push((await pg.query(`INSERT INTO students (parent_id, name, is_active) VALUES ($1,$2,TRUE) RETURNING id`,
        [parentId, `D18b孩${i}${suffix}`])).rows[0].id);
    }
    const token = signParentToken({ parentId, phone });

    const setConfig = async (courseType, patch) => {
      const orig = (await pg.query(`SELECT min_students, max_students, is_active FROM course_type_configs WHERE course_type = $1 AND pricing_zone_id = $2`,
        [courseType, zoneId])).rows[0];
      if (!orig) throw new Error(`test database needs course_type_configs ${courseType} in zone ${zoneId}`);
      restore.push(() => pg.query(`UPDATE course_type_configs SET min_students = $3, max_students = $4, is_active = $5 WHERE course_type = $1 AND pricing_zone_id = $2`,
        [courseType, zoneId, orig.min_students, orig.max_students, orig.is_active]));
      await pg.query(`UPDATE course_type_configs SET min_students = COALESCE($3, min_students), max_students = COALESCE($4, max_students), is_active = COALESCE($5, is_active)
                       WHERE course_type = $1 AND pricing_zone_id = $2`,
        [courseType, zoneId, patch.min ?? null, patch.max ?? null, patch.active ?? null]);
    };
    const setCoachActive = async (active) => {
      await pg.query(`UPDATE coaches SET is_active = $2 WHERE id = $1`, [coachId, active]);
    };
    restore.push(() => setCoachActive(true));

    // ───────────────────────── P 個人報名一對五 ─────────────────────────
    if (runs('P')) {
      await setConfig(5, { min: 5, max: 5, active: true });
      const enroll = (n, tag) => call(route.base, 'POST', '/api/enrollments', token, {
        request_id: `e2e-d18b-${tag}-${suffix}`, coach: { id: coachId }, venue: { id: venueId },
        course_type: 5, students: kids.slice(0, n).map((id) => ({ id })), period_count: 1,
      }, { 'Idempotency-Key': `e2e-d18b-${tag}-${suffix}` });

      step('P1 一對五只選 3 位 → 擋下 STUDENT_COUNT_MUST_MATCH_COURSE_TYPE，不建單');
      const short = await enroll(3, 'p1');
      assert(short.status === 400 && short.data?.code === 'STUDENT_COUNT_MUST_MATCH_COURSE_TYPE',
        `3 位被擋（${short.status} ${short.data?.code}）`);

      step('P2 一對五選滿 5 位 → 照常成立');
      const full = await enroll(5, 'p2');
      assert(full.status === 201 && (full.data?.enrollment_ids || []).length === 5, `5 位成立（${full.status} ${full.data?.code || ''}）`);
    }

    // ───────────────────────── G 團購 ─────────────────────────
    if (runs('G')) {
      step('G1 教練已停用 → 不能發起團購（COACH_INACTIVE）');
      await setCoachActive(false);
      const create = await call(route.base, 'POST', '/api/group-orders', token, {
        course_type: 3, venue_id: venueId, coach_id: coachId, student_ids: [kids[0]], period_count: 1,
      });
      if (create.data?.id) groupIds.push(create.data.id);
      assert(create.status === 400 && create.data?.code === 'COACH_INACTIVE', `發起被擋（${create.status} ${create.data?.code}）`);
      await setCoachActive(true);

      const groupId = randomUUID();
      const joinToken = `d18b${suffix}`;
      groupIds.push(groupId);
      await pg.query(
        `INSERT INTO group_orders (id, leader_parent_id, venue_id, course_type, coach_id, status, join_token, min_students, max_students, period_count)
         VALUES ($1,$2,$3,3,$4,'forming',$5,3,3,1)`, [groupId, leaderId, venueId, coachId, joinToken]);
      await pg.query(
        `INSERT INTO group_order_members (group_order_id, parent_id, student_names, student_ids, is_leader)
         VALUES ($1,$2,$3,$4,TRUE)`, [groupId, leaderId, [`團主孩${suffix}`], [randomUUID()]]);
      const join = () => call(route.base, 'POST', `/api/group-orders/by-token/${joinToken}/join`, token, { student_ids: [kids[0]] });
      const memberCount = async () => (await pg.query(`SELECT count(*)::int AS n FROM group_order_members WHERE group_order_id = $1`, [groupId])).rows[0].n;

      step('G2 組別停用後 → 不能再加入（COURSE_TYPE_INACTIVE），成員數不變');
      await setConfig(3, { active: false });
      const j1 = await join();
      assert(j1.status === 409 && j1.data?.code === 'COURSE_TYPE_INACTIVE', `加入被擋（${j1.status} ${j1.data?.code}）`);
      assert(await memberCount() === 1, '成員仍只有團主');
      await setConfig(3, { active: true });

      step('G3 教練停用後 → 不能再加入（COACH_INACTIVE），成員數不變');
      await setCoachActive(false);
      const j2 = await join();
      assert(j2.status === 409 && j2.data?.code === 'COACH_INACTIVE', `加入被擋（${j2.status} ${j2.data?.code}）`);
      assert(await memberCount() === 1, '成員仍只有團主');
      await setCoachActive(true);

      step('G4 條件恢復 → 可以加入（對照）');
      const j3 = await join();
      assert(j3.status >= 200 && j3.status < 300, `加入成功（${j3.status} ${j3.data?.code || ''}）`);
      assert(await memberCount() === 2, '成員變成 2 戶');
    }

    // 轉讓與評價共用的課期
    const period = async (expiresSql) => {
      const id = (await pg.query(
        `INSERT INTO course_periods (coach_id, venue_id, course_type, total_sessions, used_sessions, status, original_price, final_price, expires_at)
         VALUES ($1,$2,1,4,0,'active',1000,1000,${expiresSql}) RETURNING id`, [coachId, venueId])).rows[0].id;
      periodIds.push(id);
      await pg.query(`INSERT INTO course_period_enrollments (course_period_id, student_id, status) VALUES ($1,$2,'active')`, [id, kids[0]]);
      return id;
    };

    // ───────────────────────── T 轉讓申請 ─────────────────────────
    if (runs('T')) {
      step('T1 同一學員同一課期同時送兩次轉讓申請 → 只成立一筆，另一筆 409');
      const p1 = await period('CURRENT_DATE + 60');
      const req = () => transfers.createRequest({ parentId, periodId: p1, fromStudentId: kids[0], toPhone: `09${digits(7)}`, toStudentName: '接手學員', reason: 'e2e' });
      const results = await Promise.allSettled([req(), req()]);
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const dup = results.filter((r) => r.status === 'rejected' && r.reason?.status === 409).length;
      const rows = (await pg.query(`SELECT count(*)::int AS n FROM transfer_records WHERE course_period_id = $1 AND status = 'pending_review'`, [p1])).rows[0].n;
      assert(ok === 1 && dup === 1 && rows === 1, `成立 ${ok}、被擋 ${dup}、資料庫 ${rows} 筆`);

      step('T2 過期課期 → 不可申請轉讓（PERIOD_EXPIRED）');
      const p2 = await period('CURRENT_DATE - 1');
      let err = null;
      try { await transfers.createRequest({ parentId, periodId: p2, fromStudentId: kids[0], toPhone: `09${digits(8)}`, reason: 'e2e' }); } catch (e) { err = e; }
      assert(err && err.status === 409 && err.code === 'PERIOD_EXPIRED', `過期被擋（${err ? `${err.status} ${err.code}` : '成立'}）`);
    }

    // ───────────────────────── V 評價 ─────────────────────────
    if (runs('V')) {
      step('V1 同一份評價同時送兩次 → 只有一次生效，另一次 409，分數是生效那次的');
      const p3 = await period('CURRENT_DATE + 60');
      const evalId = (await pg.query(
        `INSERT INTO course_evaluations (course_period_id, parent_id, coach_id, invited_at) VALUES ($1,$2,$3,NOW()) RETURNING id`,
        [p3, parentId, coachId])).rows[0].id;
      evalIds.push(evalId);
      const payload = (n) => ({ score_teaching: n, score_attitude: n, score_progress: n, score_overall: n, comment: `第${n}次`, renew_intent: 'unknown' });
      const results = await Promise.allSettled([evaluations.submit(evalId, [parentId], payload(5)), evaluations.submit(evalId, [parentId], payload(1))]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected' && r.reason?.status === 409);
      assert(won.length === 1 && lost.length === 1, `生效 ${won.length}、被擋 ${lost.length}`);
      const saved = (await pg.query(`SELECT score_overall FROM course_evaluations WHERE id = $1`, [evalId])).rows[0].score_overall;
      assert(won.length === 1 && Number(saved) === Number(won[0].value.score_overall), `資料庫分數＝生效那次（${saved}）`);
    }
  } finally {
    for (const fn of restore.reverse()) await fn().catch(() => {});
    if (evalIds.length) await pg.query(`DELETE FROM course_evaluations WHERE id = ANY($1::uuid[])`, [evalIds]).catch(() => {});
    await pg.query(`DELETE FROM transfer_records WHERE from_parent_id = $1`, [parentId]).catch(() => {});
    if (periodIds.length) {
      await pg.query(`DELETE FROM course_period_enrollments WHERE course_period_id = ANY($1::uuid[])`, [periodIds]).catch(() => {});
      await pg.query(`DELETE FROM course_periods WHERE id = ANY($1::uuid[])`, [periodIds]).catch(() => {});
    }
    const groups = (await pg.query(`SELECT id FROM group_orders WHERE leader_parent_id = ANY($1::uuid[])`, [[parentId, leaderId]]).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
    const allGroups = [...new Set([...groupIds, ...groups])];
    if (allGroups.length) {
      await pg.query(`DELETE FROM promotion_usages WHERE group_order_id = ANY($1::uuid[])`, [allGroups]).catch(() => {});
      await pg.query(`DELETE FROM group_order_audit_logs WHERE group_order_id = ANY($1::uuid[])`, [allGroups]).catch(() => {});
      await pg.query(`DELETE FROM group_order_members WHERE group_order_id = ANY($1::uuid[])`, [allGroups]).catch(() => {});
      await pg.query(`DELETE FROM group_orders WHERE id = ANY($1::uuid[])`, [allGroups]).catch(() => {});
    }
    const orderIds = (await pg.query(`SELECT id FROM admin_enrollments WHERE parent_phone = $1`, [phone]).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
    if (orderIds.length) {
      await pg.query(`DELETE FROM promotion_usages WHERE admin_enrollment_id = ANY($1::text[])`, [orderIds]).catch(() => {});
      await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [orderIds]).catch(() => {});
      await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [orderIds]).catch(() => {});
    }
    await pg.query(`DELETE FROM checkout_sessions WHERE parent_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM request_idempotency_ledger WHERE actor_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [[parentId, leaderId]]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [[parentId, leaderId]]).catch(() => {});
    await pg.end();
    await route.close();
    const { pool } = require('../../server/models/db');
    await pool.end().catch(() => {});
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
