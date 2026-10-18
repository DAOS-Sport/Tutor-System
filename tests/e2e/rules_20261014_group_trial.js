/*
 * 2026-10-14 使用者三項規則 e2e（in-process 掛 router、拋棄式 PostgreSQL、finally 清理）：
 *   C 試上比照正式課：一對二試上要選滿 2 位；同批同堂開成同一個共用體驗課期（體驗標記、效期 30 天）；
 *     整班簽到一次兩人都記出席、教練 1 堂；試上退費走整班整期；舊「每人一張」試上重跑對帳不新增課期。
 *   B 團報人數＝組別：送審資格／自動送審門檻看組別（舊團存的 min 2 不再放寬）；核准前再核人數；
 *     後台存組別時 min＝max＝組別。
 *   A 團報整團一起退：退其中一家＝同團同期全部退；未付款家庭改取消（付款單一併取消）；課期停用。
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const { signToken: signAdminToken } = require('../../server/middlewares/adminAuth');
const enrollmentRouter = require('../../server/routes/enrollments');
const checkinsRouter = require('../../server/routes/checkins');
const adminEnrollmentRouter = require('../../server/routes/admin/enrollments');
const adminCheckoutsRouter = require('../../server/routes/admin/checkouts');
const adminGroupOrdersRouter = require('../../server/routes/admin/groupOrders');
const adminCourseTypesRouter = require('../../server/routes/admin/courseTypes');
const { pool } = require('../../server/models/db');
const { evaluateSubmitReadiness, isFullHouse, requiredGroupSize } = require('../../server/services/groupOrderSubmit');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/checkins', checkinsRouter);
  app.use('/api/admin/enrollments', adminEnrollmentRouter);
  app.use('/api/admin/checkouts', adminCheckoutsRouter);
  app.use('/api/admin/group-orders', adminGroupOrdersRouter);
  app.use('/api/admin/course-types', adminCourseTypesRouter);
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
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
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
  const digits = (n) => String(parseInt(suffix.slice(0, 8), 16) + n).padStart(8, '0').slice(-8);
  const parentIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const phones = parentIds.map((_, i) => `09${digits(i)}`);
  const groupIds = [];
  const checkoutIds = [];
  let cfg2Orig = null;
  let cfg3Orig = null;
  let zoneId = null;

  try {
    const reference = await pg.query(
      `SELECT c.id AS coach_id, c.name AS coach_name, v.id AS venue_id, v.pricing_zone_id
         FROM coaches c CROSS JOIN venues v
        WHERE c.is_active = TRUE AND COALESCE(c.is_placeholder, FALSE) = FALSE AND v.is_active = TRUE
        ORDER BY c.created_at, v.id LIMIT 1`
    );
    if (!reference.rowCount) throw new Error('test database needs one active non-placeholder coach and venue');
    const { coach_id: coachId, coach_name: coachName, venue_id: venueId } = reference.rows[0];
    zoneId = reference.rows[0].pricing_zone_id;
    const adminActor = (await pg.query(
      `SELECT id, username, name FROM admin_users WHERE is_active = TRUE ORDER BY created_at, id LIMIT 1`
    )).rows[0];
    if (!adminActor) throw new Error('test database needs one active admin user');
    const adminToken = signAdminToken({ sub: adminActor.id, username: adminActor.username, name: adminActor.name, role: 'admin', venue_ids: [] });

    cfg2Orig = (await pg.query(`SELECT trial_enabled, trial_price FROM course_type_configs WHERE course_type = 2 AND pricing_zone_id = $1`, [zoneId])).rows[0] || null;
    cfg3Orig = (await pg.query(`SELECT min_students, max_students, base_price FROM course_type_configs WHERE course_type = 3 AND pricing_zone_id = $1`, [zoneId])).rows[0] || null;
    if (!cfg2Orig || !cfg3Orig) throw new Error('test database needs course_type_configs 2 and 3 in the venue zone');
    await pg.query(`UPDATE course_type_configs SET trial_enabled = TRUE, trial_price = 700 WHERE course_type = 2 AND pricing_zone_id = $1`, [zoneId]);

    // 家長 0：試上；家長 1–3：團報。家長須有真實 line_uid 才會被對帳自動開通課期。
    for (let i = 0; i < parentIds.length; i += 1) {
      await pg.query(`INSERT INTO parents (id, phone, name, line_uid, is_active) VALUES ($1,$2,$3,$4,TRUE)`,
        [parentIds[i], phones[i], `E2E 規則家長${i} ${suffix}`, `e2erule${i}_${suffix}`]);
    }
    const kid = async (parentId, name) => (await pg.query(
      `INSERT INTO students (parent_id, name, is_active) VALUES ($1,$2,TRUE) RETURNING id`, [parentId, name])).rows[0].id;
    const trialKidA = await kid(parentIds[0], `試上甲${suffix}`);
    const trialKidB = await kid(parentIds[0], `試上乙${suffix}`);
    const parentToken = signParentToken({ parentId: parentIds[0], phone: phones[0] });

    // ───────────────────────── C 試上比照正式課 ─────────────────────────
    step('C1 一對二試上只選 1 位 → 前後端一致擋下（要選滿 2 位）');
    const one = await call(route.base, 'POST', '/api/enrollments', parentToken, {
      request_id: `e2e-rule-trial1-${suffix}`, coach: { id: coachId }, venue: { id: venueId },
      course_type: 2, students: [{ id: trialKidA }], period_count: 1, order_kind: 'trial', payment_method: 'on_site',
    }, { 'Idempotency-Key': `e2e-rule-trial1-${suffix}` });
    assert(one.status === 400 && one.data?.code === 'STUDENT_COUNT_MUST_MATCH_COURSE_TYPE',
      `1 位被擋 STUDENT_COUNT_MUST_MATCH_COURSE_TYPE（${one.status} ${one.data?.code}）`);

    step('C2 一對二試上 2 位 × 2 堂 → 拆 4 筆子訂單');
    const two = await call(route.base, 'POST', '/api/enrollments', parentToken, {
      request_id: `e2e-rule-trial2-${suffix}`, coach: { id: coachId }, venue: { id: venueId },
      course_type: 2, students: [{ id: trialKidA }, { id: trialKidB }], period_count: 2, order_kind: 'trial', payment_method: 'on_site',
    }, { 'Idempotency-Key': `e2e-rule-trial2-${suffix}` });
    assert(two.status === 201 && (two.data?.enrollment_ids || []).length === 4, `建單 4 筆（${two.status} ${(two.data?.enrollment_ids || []).length}）`);
    checkoutIds.push(two.data.checkout_id);
    const trialIds = two.data.enrollment_ids;
    const batchId = (await pg.query(`SELECT DISTINCT enrollment_batch_id FROM admin_enrollments WHERE id = ANY($1::text[])`, [trialIds])).rows;
    assert(batchId.length === 1, '4 筆同一批號');

    step('C3 對帳一次 → 每一堂開 1 個共用體驗課期（2 位都在名單、1 堂、體驗標記、效期 30 天）');
    const rec = await call(route.base, 'POST', `/api/admin/checkouts/${two.data.checkout_id}/reconcile`, adminToken, {
      invoice_number: 'EF13572468', invoice_image_url: `https://example.com/e2e-rule-${suffix}.jpg`,
    });
    assert(rec.status === 200, `對帳通過（${rec.status} ${JSON.stringify(rec.data || {}).slice(0, 120)}）`);
    const periods = (await pg.query(
      `SELECT cp.id, cp.period_number, cp.total_sessions, cp.is_experience_course, cp.status::text AS status,
              (cp.expires_at - CURRENT_DATE)::int AS days_left,
              (SELECT COUNT(*)::int FROM course_period_enrollments cpe WHERE cpe.course_period_id = cp.id AND cpe.status = 'active') AS enrolled
         FROM course_periods cp
        WHERE cp.enrollment_batch_id = $1 OR cp.admin_enrollment_id = ANY($2::text[])
        ORDER BY cp.period_number`, [batchId[0].enrollment_batch_id, trialIds])).rows;
    assert(periods.length === 2 && periods.map((p) => p.period_number).join() === '1,2', `只開 2 個課期（第 1、2 堂）：${periods.length}`);
    assert(periods.every((p) => p.total_sessions === 1 && p.is_experience_course === true && p.enrolled === 2
      && p.days_left >= 29 && p.days_left <= 31 && p.status === 'active'),
      `每個課期＝1 堂・體驗標記・2 位學員・效期 30 天（${JSON.stringify(periods.map((p) => [p.total_sessions, p.is_experience_course, p.enrolled, p.days_left]))}）`);

    step('C4 第 1 堂整班簽到一次 → 2 人出席、1 個課堂、該堂兩張訂單各用 1 堂、第 2 堂不動');
    const checkin = await call(route.base, 'POST', '/api/checkins/self', parentToken, {
      course_period_id: periods[0].id, student_ids: [trialKidA, trialKidB],
    });
    assert(checkin.status === 201 && checkin.data?.ok === true, `整班簽到成功（${checkin.status} ${checkin.data?.code || ''}）`);
    const landed = (await pg.query(
      `SELECT (SELECT COUNT(*)::int FROM course_sessions WHERE course_period_id = $1) AS sessions,
              (SELECT COUNT(*)::int FROM checkin_records cr JOIN course_sessions cs ON cs.id = cr.course_session_id
                WHERE cs.course_period_id = $1 AND cr.attendance_status = 'ATTENDED') AS attended,
              (SELECT string_agg(used_sessions::text, ',' ORDER BY id) FROM admin_enrollments WHERE id = ANY($2::text[]) AND period_number = 1) AS p1_used,
              (SELECT string_agg(used_sessions::text, ',' ORDER BY id) FROM admin_enrollments WHERE id = ANY($2::text[]) AND period_number = 2) AS p2_used`,
      [periods[0].id, trialIds])).rows[0];
    assert(landed.sessions === 1 && landed.attended === 2, `1 個課堂、2 筆出席（${landed.sessions}/${landed.attended}）`);
    assert(landed.p1_used === '1,1' && landed.p2_used === '0,0', `第 1 堂兩張訂單各 1、第 2 堂各 0（${landed.p1_used} / ${landed.p2_used}）`);

    step('C5 第 2 堂任一張訂單退費預覽 → 整班整期（兩張一起）');
    const p2Order = (await pg.query(`SELECT id FROM admin_enrollments WHERE id = ANY($1::text[]) AND period_number = 2 ORDER BY id LIMIT 1`, [trialIds])).rows[0].id;
    const tp = await call(route.base, 'GET', `/api/admin/enrollments/${p2Order}/refund-preview`, adminToken);
    assert(tp.status === 200 && tp.data?.family_shared === true && (tp.data?.sibling_ids || []).length === 2,
      `試上整班退費（${tp.status} family_shared=${tp.data?.family_shared} siblings=${(tp.data?.sibling_ids || []).length}）`);

    step('C6 舊形狀（每人一張、不掛批號）的試上重跑開課 → 新增課期＝0');
    const { ensureSoloCoursePeriod } = adminEnrollmentRouter._checkoutInternals;
    const legacyBatch = randomUUID();
    const legacyIds = [`ELEG${suffix.toUpperCase()}A`, `ELEG${suffix.toUpperCase()}B`];
    for (const [i, kidId] of [trialKidA, trialKidB].entries()) {
      await pg.query(
        `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, student_ids, coach, coach_id, venue_id, course_type,
            original_price, final_price, status, submitted_at, total_sessions, used_sessions, period_count, period_number,
            enrollment_batch_id, order_kind, payment_method)
         VALUES ($1,'E2E 規則家長0',$2,$3,$4,$5,$6,$7,2,700,700,'confirmed',NOW(),1,0,1,1,$8,'trial','on_site')`,
        [legacyIds[i], phones[0], [`舊試上${i}`], [kidId], coachName, coachId, venueId, legacyBatch]);
      const lp = (await pg.query(
        `INSERT INTO course_periods (coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at,
            original_price, final_price, status, admin_enrollment_id, is_experience_course, period_number)
         VALUES ($1,$2,2,1,0,(NOW() + interval '30 days')::date,700,700,'active',$3,TRUE,1) RETURNING id`,
        [coachId, venueId, legacyIds[i]])).rows[0].id;
      await pg.query(`INSERT INTO course_period_enrollments (course_period_id, student_id, status) VALUES ($1,$2,'active')`, [lp, kidId]);
    }
    const countLegacy = async () => Number((await pg.query(
      `SELECT COUNT(*) AS n FROM course_periods WHERE admin_enrollment_id = ANY($1::text[]) OR enrollment_batch_id = $2`,
      [legacyIds, legacyBatch])).rows[0].n);
    const beforeLegacy = await countLegacy();
    const legacyRow = (await pg.query(`SELECT * FROM admin_enrollments WHERE id = $1`, [legacyIds[1]])).rows[0];
    const lc = await pool.connect();
    try {
      await lc.query('BEGIN');
      await ensureSoloCoursePeriod(lc, legacyRow, 1);
      await lc.query('COMMIT');
    } catch (e) { await lc.query('ROLLBACK'); throw e; } finally { lc.release(); }
    const afterLegacy = await countLegacy();
    assert(beforeLegacy === 2 && afterLegacy === 2, `舊試上重跑開課不新增課期（前 ${beforeLegacy} 後 ${afterLegacy}）`);

    // ───────────────────────── B 團報人數＝組別 ─────────────────────────
    step('B1 requiredGroupSize 以組別為準，course_type 缺漏才退回 max');
    assert(requiredGroupSize({ course_type: 3, min_students: 2, max_students: 3 }) === 3, '一對三（舊團存 2–3）＝3');
    assert(requiredGroupSize({ course_type: 6, min_students: 5, max_students: 6 }) === 6, '一對六（舊團存 5–6）＝6');
    assert(requiredGroupSize({ course_type: null, max_students: 4 }) === 4, 'course_type 缺漏退回 max');

    const groupKids = [];
    for (let i = 1; i <= 3; i += 1) groupKids.push(await kid(parentIds[i], `團報${i}${suffix}`));
    const newGroup = async ({ status, ct = 3, min = 2, max = 3 }) => {
      const id = randomUUID();
      groupIds.push(id);
      await pg.query(
        `INSERT INTO group_orders (id, leader_parent_id, venue_id, course_type, coach_id, status, join_token, min_students, max_students, period_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,
        [id, parentIds[1], venueId, ct, coachId, status, `e2erule-${randomUUID()}`, min, max]);
      return id;
    };
    const addMember = async (gid, i, extra = {}) => {
      await pg.query(
        `INSERT INTO group_order_members (group_order_id, parent_id, student_names, student_ids, transfer_last_5, payment_proof_url, is_leader)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [gid, parentIds[i], [`團報${i}${suffix}`], [groupKids[i - 1]], extra.last5 ?? '12345', extra.proof ?? 'https://example.com/proof.jpg', i === 1]);
    };

    step('B2 舊團（一對三存 min 2）2 人已付款 → 送審資格 BELOW_MIN（需 3）；第 3 人加入付款後才可送審');
    const formingId = await newGroup({ status: 'forming' });
    await addMember(formingId, 1); await addMember(formingId, 2);
    const fc = await pool.connect();
    try {
      await fc.query('BEGIN');
      const order = (await fc.query(`SELECT * FROM group_orders WHERE id = $1 FOR UPDATE`, [formingId])).rows[0];
      const r2 = await evaluateSubmitReadiness(fc, order);
      assert(r2.ok === false && r2.code === 'BELOW_MIN' && r2.required === 3 && r2.total === 2, `2/3 → BELOW_MIN（${r2.code} ${r2.total}/${r2.required}）`);
      assert(isFullHouse(order, 2) === false && isFullHouse(order, 3) === true, '自動送審滿團門檻＝3');
      await fc.query('ROLLBACK');
    } finally { fc.release(); }
    await addMember(formingId, 3);
    const fc2 = await pool.connect();
    try {
      await fc2.query('BEGIN');
      const order = (await fc2.query(`SELECT * FROM group_orders WHERE id = $1 FOR UPDATE`, [formingId])).rows[0];
      const r3 = await evaluateSubmitReadiness(fc2, order);
      assert(r3.ok === true && r3.total === 3, `3/3 → 可送審（${r3.code} ${r3.total}）`);
      await fc2.query('ROLLBACK');
    } finally { fc2.release(); }

    step('B3 已送審但只有 2 人的一對三 → 後台核准 409 GROUP_SIZE_MISMATCH、不產生訂單');
    const submittedId = await newGroup({ status: 'submitted' });
    await addMember(submittedId, 1); await addMember(submittedId, 2);
    const approve = await call(route.base, 'POST', `/api/admin/group-orders/${submittedId}/approve`, adminToken, { request_id: `e2e-rule-approve-${suffix}` });
    assert(approve.status === 409 && approve.data?.code === 'GROUP_SIZE_MISMATCH', `核准被擋（${approve.status} ${approve.data?.code}）`);
    const made = Number((await pg.query(`SELECT COUNT(*) AS n FROM admin_enrollments WHERE group_order_id = $1`, [submittedId])).rows[0].n);
    assert(made === 0, `沒有產生任何訂單（${made}）`);

    step('B4 後台存組別：舊列一對三 min 2 → 任何編輯後 min＝max＝3（不接受自訂人數）');
    await pg.query(`UPDATE course_type_configs SET min_students = 2, max_students = 3 WHERE course_type = 3 AND pricing_zone_id = $1`, [zoneId]);
    const patch = await call(route.base, 'PATCH', `/api/admin/course-types/3?zone=${zoneId}`, adminToken, {
      base_price: Number(cfg3Orig.base_price), min_students: 1, max_students: 9,
    });
    assert(patch.status === 200, `編輯成功（${patch.status} ${patch.data?.error || ''}）`);
    const ct3 = (await pg.query(`SELECT min_students, max_students FROM course_type_configs WHERE course_type = 3 AND pricing_zone_id = $1`, [zoneId])).rows[0];
    assert(ct3.min_students === 3 && ct3.max_students === 3, `一對三存成 3／3（${ct3.min_students}/${ct3.max_students}）`);

    // ───────────────────────── A 團報整團一起退 ─────────────────────────
    step('A1 已核准團報：2 家已付款、1 家未付款；其中一家按退費 → 試算列出整團');
    const approvedId = await newGroup({ status: 'approved' });
    for (const i of [1, 2, 3]) await addMember(approvedId, i);
    const orderIds = [];
    for (const i of [1, 2, 3]) {
      const checkoutId = randomUUID();
      checkoutIds.push(checkoutId);
      const paid = i !== 3;
      await pg.query(
        `INSERT INTO checkout_sessions (checkout_id, parent_id, total_amount, payment_status, current_route_state, payment_method, order_kind)
         VALUES ($1,$2,4500,$3,$3,'bank_transfer','standard')`,
        [checkoutId, parentIds[i], paid ? 'paid' : 'pending_payment']);
      const eid = `EGRP${suffix.toUpperCase()}${i}`;
      orderIds.push(eid);
      await pg.query(
        `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
            original_price, final_price, status, submitted_at, total_sessions, used_sessions, period_count, period_number,
            group_order_id, checkout_id, is_group_shared)
         VALUES ($1,$2,$3,$4,$5,$6,$7,3,4500,4500,$8,NOW() + ($9 || ' seconds')::interval,6,0,1,1,$10,$11,TRUE)`,
        [eid, `E2E 規則家長${i} ${suffix}`, phones[i], [`團報${i}${suffix}`], coachName, coachId, venueId,
          paid ? 'confirmed' : 'pending_payment', String(i), approvedId, checkoutId]);
    }
    const gp = (await pg.query(
      `INSERT INTO course_periods (coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at,
          original_price, final_price, status, admin_enrollment_id, group_order_id, period_number, checkin_mode)
       VALUES ($1,$2,3,6,1,(NOW() + interval '365 days')::date,13500,13500,'active',$3,$4,1,'booking') RETURNING id`,
      [coachId, venueId, orderIds[0], approvedId])).rows[0].id;
    for (const k of groupKids.slice(0, 2)) {
      await pg.query(`INSERT INTO course_period_enrollments (course_period_id, student_id, status) VALUES ($1,$2,'active')`, [gp, k]);
    }
    const sess = (await pg.query(
      `INSERT INTO course_sessions (course_period_id, coach_id, scheduled_at, status, completed_at, session_deducted)
       VALUES ($1,$2,NOW() - interval '2 days','completed',NOW() - interval '2 days',TRUE) RETURNING id`, [gp, coachId])).rows[0].id;
    for (const k of groupKids.slice(0, 2)) {
      await pg.query(`INSERT INTO checkin_records (course_session_id, student_id, checked_in_source, attendance_status) VALUES ($1,$2,'staff','ATTENDED')`, [sess, k]);
    }
    const future = (await pg.query(
      `INSERT INTO course_sessions (course_period_id, coach_id, scheduled_at, status)
       VALUES ($1,$2,NOW() + interval '3 days','confirmed') RETURNING id`, [gp, coachId])).rows[0].id;

    const gpv = await call(route.base, 'GET', `/api/admin/enrollments/${orderIds[1]}/refund-preview?fee_rate=0`, adminToken);
    assert(gpv.status === 200 && gpv.data?.group_shared === true, `試算為團報整團（${gpv.status} ${gpv.data?.error || ''}）`);
    assert(JSON.stringify(gpv.data.sibling_ids) === JSON.stringify(orderIds.slice(0, 2)) && JSON.stringify(gpv.data.cancel_ids) === JSON.stringify([orderIds[2]]),
      `已付款 2 家退費、未付款 1 家取消（${JSON.stringify(gpv.data.sibling_ids)} / ${JSON.stringify(gpv.data.cancel_ids)}）`);
    assert(gpv.data.used === 1 && gpv.data.total === 6 && gpv.data.refund_amount === 7500
      && gpv.data.sibling_refunds.every((r) => r.refund_amount === 3750 && r.parent_name),
      `已用 1/6、每家退 3750、合計 7500、列出家長（${gpv.data.used}/${gpv.data.total} ${gpv.data.refund_amount}）`);

    step('A2 執行退費 → 兩家退費、未付款家庭取消（付款單一併取消）、課期停用、未上的預約取消、稽核每筆一列');
    const gr = await call(route.base, 'POST', `/api/admin/enrollments/${orderIds[1]}/refund`, adminToken, {
      reason: 'e2e 團報整團退費', fee_rate: 0, expected_refund_amount: 7500,
    });
    assert(gr.status === 200 && gr.data?.group_shared === true && gr.data?.refund_amount === 7500,
      `退費成功（${gr.status} ${gr.data?.error || ''} ${gr.data?.refund_amount}）`);
    const after = (await pg.query(`SELECT id, status, refund_amount::float8 AS refund_amount, used_sessions FROM admin_enrollments WHERE id = ANY($1::text[]) ORDER BY id`, [orderIds])).rows;
    assert(after.map((r) => r.status).join() === 'refunded,refunded,cancelled', `訂單狀態（${after.map((r) => r.status).join()}）`);
    assert(after[0].refund_amount === 3750 && after[1].refund_amount === 3750 && after[0].used_sessions === 1, '各家退款金額與已用堂數入庫');
    const cs3 = (await pg.query(`SELECT payment_status FROM checkout_sessions WHERE checkout_id = $1`, [checkoutIds[checkoutIds.length - 1]])).rows[0];
    assert(cs3.payment_status === 'cancelled', `未付款家庭的付款單轉取消（${cs3.payment_status}）`);
    const per = (await pg.query(`SELECT status::text AS status, entitlement_state FROM course_periods WHERE id = $1`, [gp])).rows[0];
    assert(per.status === 'refunded' && per.entitlement_state === 'MANUAL_REVIEW', `課期停用（${per.status}/${per.entitlement_state}）`);
    const fut = (await pg.query(`SELECT status::text AS status FROM course_sessions WHERE id = $1`, [future])).rows[0];
    assert(fut.status === 'cancelled_normal', `未上課的預約取消（${fut.status}）`);
    const audits = (await pg.query(`SELECT enrollment_id, action FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[]) ORDER BY enrollment_id`, [orderIds])).rows;
    assert(audits.length === 3 && audits[0].action.includes('團報整團退費') && audits[1].action.includes('團報整團退費')
      && audits[2].action.includes('取消報名'), `稽核 3 列（${audits.map((a) => a.action.slice(0, 12)).join(' | ')}）`);
    const again = await call(route.base, 'POST', `/api/admin/enrollments/${orderIds[0]}/refund`, adminToken, { reason: 'e2e again', fee_rate: 0 });
    assert(again.status === 400, `已退的家庭不能再退（${again.status}）`);

    step('PASS: 試上共班／團報人數＝組別／團報整團退費 全數通過');
  } finally {
    const phoneList = phones;
    await pg.query(`DELETE FROM checkin_records WHERE student_id IN (SELECT id FROM students WHERE parent_id = ANY($1::uuid[]))`, [parentIds]).catch(() => {});
    await pg.query(`DELETE FROM course_sessions WHERE course_period_id IN (
        SELECT id FROM course_periods WHERE admin_enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = ANY($1::text[]))
           OR group_order_id = ANY($2::uuid[]))`, [phoneList, groupIds]).catch(() => {});
    await pg.query(`DELETE FROM course_period_enrollments WHERE student_id IN (SELECT id FROM students WHERE parent_id = ANY($1::uuid[]))`, [parentIds]).catch(() => {});
    await pg.query(`DELETE FROM chat_rooms WHERE course_period_id IN (
        SELECT id FROM course_periods WHERE admin_enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = ANY($1::text[]))
           OR group_order_id = ANY($2::uuid[]))`, [phoneList, groupIds]).catch(() => {});
    await pg.query(`DELETE FROM course_periods WHERE admin_enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = ANY($1::text[]))
        OR group_order_id = ANY($2::uuid[])`, [phoneList, groupIds]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = ANY($1::text[]))`, [phoneList]).catch(() => {});
    await pg.query(`DELETE FROM checkout_invoices WHERE checkout_id = ANY($1::uuid[])`, [checkoutIds]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE parent_phone = ANY($1::text[])`, [phoneList]).catch(() => {});
    await pg.query(`DELETE FROM group_order_audit_logs WHERE group_order_id = ANY($1::uuid[])`, [groupIds]).catch(() => {});
    await pg.query(`DELETE FROM group_order_members WHERE group_order_id = ANY($1::uuid[])`, [groupIds]).catch(() => {});
    await pg.query(`DELETE FROM group_orders WHERE id = ANY($1::uuid[])`, [groupIds]).catch(() => {});
    await pg.query(`DELETE FROM request_idempotency_ledger WHERE actor_id = ANY($1::text[])`, [parentIds]).catch(() => {});
    await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::uuid[]) OR parent_id = ANY($2::uuid[])`, [checkoutIds, parentIds]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [parentIds]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [parentIds]).catch(() => {});
    if (cfg2Orig) await pg.query(`UPDATE course_type_configs SET trial_enabled = $1, trial_price = $2 WHERE course_type = 2 AND pricing_zone_id = $3`, [cfg2Orig.trial_enabled, cfg2Orig.trial_price, zoneId]).catch(() => {});
    if (cfg3Orig) await pg.query(`UPDATE course_type_configs SET min_students = $1, max_students = $2 WHERE course_type = 3 AND pricing_zone_id = $3`, [cfg3Orig.min_students, cfg3Orig.max_students, zoneId]).catch(() => {});
    await pg.end().catch(() => {});
    await pool.end().catch(() => {});
    await route.close().catch(() => {});
  }
  step('rules 2026-10-14 cleanup complete');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
