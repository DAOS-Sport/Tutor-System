/*
 * 家庭帳號第二階段（docs/family_accounts_spec_2026-09-23.md §5 第二階段；決策 4、6、7）端對端：
 * 真實路由（報名、付款單對帳、團購）＋真實 DB，家長 token 直接簽，不起外部伺服器。
 *
 *   1. 爸爸替媽媽名下的孩子報名 → 201；購買人是爸爸，訂單記下孩子的 id
 *   2. 陌生人拿同一個孩子報名 → 403
 *   3. 櫃台對帳 → 課期綁在媽媽名下那個孩子；爸爸名下不會多出同名孩子（舊的姓名比對會多建）
 *   4. 開關關閉 → 爸爸替家人的孩子報名被擋
 *   5. 媽媽開團 → 爸爸的邀請頁顯示家人已加入、參團 409 FAMILY_ALREADY_MEMBER；陌生人照常可參團
 *   6. 爸爸開團時新增「同一個孩子」（身分證相同）→ 沿用媽媽名下那份，不多建
 *   7. 優惠「每人上限 1 期」：媽媽用掉之後，爸爸再報不會自動套用（家庭合計）
 *   8. 同一家庭互推：體驗簽到發獎時不發券；對照組（不同家庭）照常發
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signToken } = require('../../server/middlewares/adminAuth');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const enrollmentsRouter = require('../../server/routes/enrollments');
const adminCheckoutsRouter = require('../../server/routes/admin/checkouts');
const groupOrdersRouter = require('../../server/routes/groupOrders');
const familyAdmin = require('../../server/services/familyAdmin');
const referrals = require('../../server/services/referrals');
const { pool } = require('../../server/models/db');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', enrollmentsRouter);
  app.use('/api/admin/checkouts', adminCheckoutsRouter);
  app.use('/api/group-orders', groupOrdersRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'test route failure: ' + err.message }));
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
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

const hex32 = () => randomUUID().replace(/-/g, '');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  step('家庭帳號第二階段：替家人的孩子報名、對帳綁對人、團購一家一戶、優惠與推薦以家庭計');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();

  const suffix = hex32().slice(0, 8);
  const digits = String(parseInt(suffix, 16)).padStart(10, '0').slice(-7);
  const venueId = `FM${suffix.slice(0, 6).toUpperCase()}`;
  const coachId = randomUUID();
  const courseType = 2000000 + (parseInt(suffix.slice(0, 6), 16) % 1000000);
  const mk = (tag, n) => ({ id: randomUUID(), name: `家庭${tag}${suffix}`, phone: `09${n}${digits}`, line_uid: 'U' + hex32() });
  const mom = mk('媽媽', 1);
  const dad = mk('爸爸', 2);
  const stranger = mk('陌生人', 3);
  const kid = { id: randomUUID(), name: `家庭孩子${suffix}`, id_number: `A1${digits}1`, birth_date: '2018-03-03' };
  const strangerKid = { id: randomUUID(), name: `陌生孩子${suffix}` };
  const created = { enrollments: [], checkouts: [], batches: [], groups: [], promotions: [], referrals: [], families: [] };
  let zoneId = null;
  let courseTypeCreated = false;
  const prevFlag = process.env.FAMILY_ACCOUNTS_V1;
  process.env.FAMILY_ACCOUNTS_V1 = 'all';

  const token = (p) => signParentToken({ parentId: p.id, phone: p.phone, lineUid: p.line_uid });
  const adminToken = signToken({ sub: randomUUID(), username: 'family-e2e-admin', name: '家庭驗證管理員', role: 'admin' });
  const enroll = (who, extra = {}) => call(route.base, 'POST', '/api/enrollments', {
    token: token(who),
    body: {
      coach: { id: coachId, name: `家庭教練${suffix}` },
      venue: { id: venueId, name: `家庭測試館${suffix}` },
      course_type: courseType,
      students: [{ id: kid.id, name: kid.name }],
      period_count: 1,
      request_id: `e2e-family-${hex32()}`,
      ...extra,
    },
  });
  const track = (r) => {
    if (r.data?.enrollment_ids) created.enrollments.push(...r.data.enrollment_ids);
    if (r.data?.checkout_id) created.checkouts.push(r.data.checkout_id);
    if (r.data?.batch_id) created.batches.push(r.data.batch_id);
    return r;
  };

  try {
    zoneId = (await pg.query(
      `INSERT INTO pricing_zones (name, sessions_per_period, sort_order) VALUES ($1, 6, 997) RETURNING id`,
      [`家庭測試區${suffix}`])).rows[0].id;
    await pg.query(`INSERT INTO venues (id, name, is_active, pricing_zone_id) VALUES ($1, $2, TRUE, $3)`,
      [venueId, `家庭測試館${suffix}`, zoneId]);
    await pg.query(
      `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active, pricing_multiplier)
       VALUES ($1, $2, $3, $4, TRUE, 1.00)`,
      [coachId, `家庭教練${suffix}`, `08${digits}9`, `FAM-${suffix}`]);
    await pg.query(`INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2)`, [coachId, venueId]);
    courseTypeCreated = (await pg.query(
      `INSERT INTO course_types (course_type) VALUES ($1) ON CONFLICT DO NOTHING RETURNING course_type`, [courseType])).rowCount > 0;
    await pg.query(
      `INSERT INTO course_type_configs
         (pricing_zone_id, course_type, label, min_students, max_students, sort_order, base_price, is_active)
       VALUES ($2, $1, '家庭測試一對四', 1, 4, 997, 4000, TRUE)`,
      [courseType, zoneId]);
    for (const p of [mom, dad, stranger]) {
      await pg.query(`INSERT INTO parents (id, name, phone, line_uid, is_active) VALUES ($1, $2, $3, $4, TRUE)`,
        [p.id, p.name, p.phone, p.line_uid]);
    }
    await pg.query(
      `INSERT INTO students (id, parent_id, name, id_number, birth_date, is_active, ragic_record_id)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
      [kid.id, mom.id, kid.name, kid.id_number, kid.birth_date, `fam-e2e-${suffix}`]);
    await pg.query(`INSERT INTO students (id, parent_id, name, is_active) VALUES ($1, $2, $3, TRUE)`,
      [strangerKid.id, stranger.id, strangerKid.name]);

    // 家庭：媽媽擁有者、爸爸成員（櫃台動作走真的服務）
    const fc = await pool.connect();
    try {
      await fc.query('BEGIN');
      const fam = await familyAdmin.createFamily(fc, { ownerParentId: mom.id, ownerRelationship: 'mother', actor: 'e2e' });
      created.families.push(fam.result.id);
      await familyAdmin.addMember(fc, { familyId: fam.result.id, parentId: dad.id, relationship: 'father', actor: 'e2e' });
      await fc.query('COMMIT');
    } catch (e) { await fc.query('ROLLBACK'); throw e; } finally { fc.release(); }

    // 1
    const dadOrder = track(await enroll(dad));
    assert(dadOrder.status === 201, `1. 爸爸替媽媽的孩子報名 201，實際 ${dadOrder.status}${dadOrder.status >= 400 ? ' ' + JSON.stringify(dadOrder.data) : ''}`);
    const orderRow = (await pg.query(
      `SELECT parent_phone, student_ids::text[] AS student_ids FROM admin_enrollments WHERE id = $1`,
      [dadOrder.data.enrollment_ids[0]])).rows[0];
    assert(orderRow.parent_phone === dad.phone, '1. 購買人是下單的爸爸');
    assert(orderRow.student_ids.length === 1 && orderRow.student_ids[0] === kid.id, '1. 訂單記下孩子的 id');

    // 2
    const strangerOrder = track(await enroll(stranger));
    assert(strangerOrder.status === 403 && strangerOrder.data?.code === 'STUDENT_NOT_AVAILABLE',
      `2. 陌生人拿同一個孩子報名被擋，實際 ${strangerOrder.status}`);

    // 3
    const reconciled = await call(route.base, 'POST', `/api/admin/checkouts/${dadOrder.data.checkout_id}/reconcile`, {
      token: adminToken, body: { invoice_number: 'FM12345678', invoice_image_url: '/uploads/e2e-family-invoice.png' },
    });
    assert(reconciled.status === 200, `3. 對帳 200，實際 ${reconciled.status}${reconciled.status >= 400 ? ' ' + JSON.stringify(reconciled.data) : ''}`);
    const bound = (await pg.query(
      `SELECT cpe.student_id FROM course_periods cp JOIN course_period_enrollments cpe ON cpe.course_period_id = cp.id
        WHERE cp.admin_enrollment_id = $1`, [dadOrder.data.enrollment_ids[0]])).rows.map((r) => r.student_id);
    assert(bound.length === 1 && bound[0] === kid.id, `3. 課期綁在媽媽名下的孩子，實際 ${JSON.stringify(bound)}`);
    const dadKids = (await pg.query(`SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1`, [dad.id])).rows[0].n;
    assert(dadKids === 0, `3. 爸爸名下沒有多出同名孩子，實際 ${dadKids}`);

    // 4
    process.env.FAMILY_ACCOUNTS_V1 = 'off';
    const offOrder = track(await enroll(dad));
    process.env.FAMILY_ACCOUNTS_V1 = 'all';
    assert(offOrder.status === 403, `4. 開關關閉時爸爸不能替家人的孩子報名，實際 ${offOrder.status}`);

    // 5
    const momGroup = await call(route.base, 'POST', '/api/group-orders', {
      token: token(mom), body: { venue_id: venueId, course_type: courseType, coach_id: coachId, student_ids: [kid.id], period_count: 1 },
    });
    assert(momGroup.status === 201, `5. 媽媽開團 201，實際 ${momGroup.status}${momGroup.status >= 400 ? ' ' + JSON.stringify(momGroup.data) : ''}`);
    created.groups.push(momGroup.data.id);
    const joinToken = momGroup.data.join_token;
    const invite = await call(route.base, 'GET', `/api/group-orders/by-token/${joinToken}`, { token: token(dad) });
    assert(invite.status === 200 && invite.data.family_member_joined === true && invite.data.joinable === false,
      `5. 爸爸的邀請頁顯示家人已加入、不能加入，實際 ${JSON.stringify({ s: invite.status, f: invite.data?.family_member_joined, j: invite.data?.joinable })}`);
    const dadJoin = await call(route.base, 'POST', `/api/group-orders/by-token/${joinToken}/join`, {
      token: token(dad), body: { new_students: [{ name: `爸爸想加的孩子${suffix}` }] },
    });
    assert(dadJoin.status === 409 && dadJoin.data?.code === 'FAMILY_ALREADY_MEMBER', `5. 爸爸參團被擋，實際 ${dadJoin.status} ${dadJoin.data?.code}`);
    const dadKidsAfterJoin = (await pg.query(`SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1`, [dad.id])).rows[0].n;
    assert(dadKidsAfterJoin === 0, '5. 被擋下的參團沒有留下新孩子');
    const strangerJoin = await call(route.base, 'POST', `/api/group-orders/by-token/${joinToken}/join`, {
      token: token(stranger), body: { student_ids: [strangerKid.id] },
    });
    assert(strangerJoin.status === 201, `5. 陌生人照常可以參團，實際 ${strangerJoin.status}${strangerJoin.status >= 400 ? ' ' + JSON.stringify(strangerJoin.data) : ''}`);

    // 6
    const dadGroup = await call(route.base, 'POST', '/api/group-orders', {
      token: token(dad),
      body: { venue_id: venueId, course_type: courseType, coach_id: coachId, period_count: 1,
        new_students: [{ name: kid.name, id_number: kid.id_number, birth_date: kid.birth_date }] },
    });
    assert(dadGroup.status === 201, `6. 爸爸開團 201，實際 ${dadGroup.status}${dadGroup.status >= 400 ? ' ' + JSON.stringify(dadGroup.data) : ''}`);
    created.groups.push(dadGroup.data.id);
    const leaderRow = (await pg.query(
      `SELECT student_ids::text[] AS student_ids FROM group_order_members WHERE group_order_id = $1 AND parent_id = $2`,
      [dadGroup.data.id, dad.id])).rows[0];
    assert(leaderRow.student_ids.length === 1 && leaderRow.student_ids[0] === kid.id, '6. 新增的同一個孩子沿用媽媽名下那份');
    const dadKidsAfterGroup = (await pg.query(`SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1`, [dad.id])).rows[0].n;
    assert(dadKidsAfterGroup === 0, `6. 爸爸名下沒有多建孩子，實際 ${dadKidsAfterGroup}`);

    // 7
    const promo = (await pg.query(
      `INSERT INTO promotions (name, description, type, discount_value, applicable_course_types, show_on_parent_home,
                               start_date, end_date, status, parent_period_cap)
       VALUES ($1, '', 'FIXED_AMOUNT', 100, $2, FALSE, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 'active', 1)
       RETURNING id`,
      [`家庭上限測試${suffix}`, [courseType]])).rows[0].id;
    created.promotions.push(promo);
    const momPromo = track(await enroll(mom));
    assert(momPromo.status === 201, `7. 媽媽報名 201，實際 ${momPromo.status}${momPromo.status >= 400 ? ' ' + JSON.stringify(momPromo.data) : ''}`);
    const momUse = (await pg.query(`SELECT COUNT(*)::int AS n FROM promotion_usages WHERE promotion_id = $1 AND parent_id = $2`, [promo, mom.id])).rows[0].n;
    assert(momUse === 1, `7. 媽媽自動套用了優惠，實際使用 ${momUse} 次`);
    const dadPromo = track(await enroll(dad));
    assert(dadPromo.status === 201, `7. 爸爸報名 201，實際 ${dadPromo.status}`);
    const dadUse = (await pg.query(`SELECT COUNT(*)::int AS n FROM promotion_usages WHERE promotion_id = $1 AND parent_id = $2`, [promo, dad.id])).rows[0].n;
    assert(dadUse === 0, `7. 家庭已用完上限，爸爸不會再自動套用（實際 ${dadUse}）`);

    // 8
    const addReferral = async (referrerId, enrollmentId) => {
      const r = await pg.query(
        `INSERT INTO referral_records (token, referrer_parent_id, coach_id, referee_parent_id, status, experience_enrollment_id)
         VALUES ($1, $2, $3, $4, 'trial_paid', $5) RETURNING id`,
        [`fam${hex32().slice(0, 20)}`, referrerId, coachId, dad.id, enrollmentId]);
      created.referrals.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const sameFamilyRef = await addReferral(mom.id, dadOrder.data.enrollment_ids[0]);
    const reward = await referrals.issueRewardForEnrollment(dadOrder.data.enrollment_ids[0]);
    const refRow = (await pg.query(`SELECT status, reward_promotion_id FROM referral_records WHERE id = $1`, [sameFamilyRef])).rows[0];
    assert(reward === null && refRow.status === 'checked_in' && !refRow.reward_promotion_id,
      `8. 同一家庭互推不發券（推薦照常推進到 checked_in），實際 ${JSON.stringify(refRow)}`);
    const controlRef = await addReferral(stranger.id, dadPromo.data.enrollment_ids[0]);
    await referrals.issueRewardForEnrollment(dadPromo.data.enrollment_ids[0]);
    const controlRow = (await pg.query(`SELECT status, reward_promotion_id FROM referral_records WHERE id = $1`, [controlRef])).rows[0];
    if (controlRow.reward_promotion_id) created.promotions.push(controlRow.reward_promotion_id);
    assert(controlRow.status === 'reward_issued' && controlRow.reward_promotion_id, '8. 對照組：不同家庭照常發券');

    step('PASS: 家庭帳號第二階段 8 項');
  } finally {
    process.env.FAMILY_ACCOUNTS_V1 = prevFlag === undefined ? '' : prevFlag;
    if (prevFlag === undefined) delete process.env.FAMILY_ACCOUNTS_V1;
    const q = (sql, args) => pg.query(sql, args).catch((e) => console.warn('cleanup:', e.message));
    await q(`DELETE FROM referral_records WHERE id = ANY($1::uuid[])`, [created.referrals]);
    await q(`DELETE FROM promotion_usages WHERE promotion_id = ANY($1::uuid[])`, [created.promotions]);
    await q(`DELETE FROM promotion_usages WHERE admin_enrollment_id = ANY($1::text[])`, [created.enrollments]);
    await q(`DELETE FROM promotions WHERE id = ANY($1::uuid[])`, [created.promotions]);
    await q(`DELETE FROM group_order_audit_logs WHERE group_order_id = ANY($1::uuid[])`, [created.groups]);
    await q(`DELETE FROM group_order_members WHERE group_order_id = ANY($1::uuid[])`, [created.groups]);
    await q(`DELETE FROM group_orders WHERE id = ANY($1::uuid[])`, [created.groups]);
    await q(`DELETE FROM course_period_enrollments WHERE course_period_id IN (SELECT id FROM course_periods WHERE admin_enrollment_id = ANY($1::text[]))`, [created.enrollments]);
    await q(`DELETE FROM course_periods WHERE admin_enrollment_id = ANY($1::text[])`, [created.enrollments]);
    await q(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [created.enrollments]);
    await q(`DELETE FROM checkout_invoices WHERE checkout_id = ANY($1::uuid[])`, [created.checkouts]);
    await q(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [created.enrollments]);
    await q(`DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::uuid[])`, [created.checkouts]);
    await q(`DELETE FROM request_idempotency_ledger WHERE actor_id = ANY($1::text[])`, [[mom.id, dad.id, stranger.id]]);
    await q(`DELETE FROM families WHERE id = ANY($1::uuid[])`, [created.families]);
    await q(`DELETE FROM student_audit_logs WHERE student_id IN (SELECT id FROM students WHERE parent_id = ANY($1::uuid[]))`, [[mom.id, dad.id, stranger.id]]);
    await q(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [[mom.id, dad.id, stranger.id]]);
    await q(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [[mom.id, dad.id, stranger.id]]);
    await q(`DELETE FROM coach_venues WHERE coach_id = $1`, [coachId]);
    await q(`DELETE FROM coaches WHERE id = $1`, [coachId]);
    await q(`DELETE FROM course_type_configs WHERE pricing_zone_id = $1`, [zoneId]);
    await q(`DELETE FROM venues WHERE id = $1`, [venueId]);
    await q(`DELETE FROM pricing_zones WHERE id = $1`, [zoneId]);
    if (courseTypeCreated) await q(`DELETE FROM course_types WHERE course_type = $1`, [courseType]);
    await route.close().catch(() => {});
    await pg.end().catch(() => {});
    await pool.end().catch(() => {});
  }
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
