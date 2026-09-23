/*
 * 家庭帳號對凍結檔的改動（docs/family_accounts_spec_2026-09-23.md §5 第一階段「要改」的 ⛔ 項；
 * 擁有者 2026-09-23 同意 courses.js／checkins.js／slots.js，cron 排程推播不改）。
 * 真實路由＋真實 DB，家長 token 直接簽。每一項都同時驗「陌生人照舊被擋」與「開關關閉回到原本行為」。
 *
 *   1. 我的課程（/courses/mine）：看得到家人買的課；陌生人看不到
 *   2. 課程詳情（/courses/:id）：家人 200、孩子名單含家人的孩子；陌生人 403
 *   3. 課表（/courses/lessons）：看得到家人孩子的堂次；陌生人看不到
 *   4. 簽到（POST /checkins）：家人可以替家裡的孩子簽到，簽到人記實際操作的家人；陌生人 403
 *   5. 預約（/slots）：家人看得到課程期、可以預約教練開放的時段；陌生人 403
 *   6. 匯款證明（POST /courses/:id/payment-proof）：家人可以替家人的訂單填末 5 碼；陌生人 403
 *   7. 取消未付款訂單：一般成員不能取消別人的單；擁有者可以
 *   8. 開關關閉：家人回到只看自己（詳情、簽到、預約全部 403）
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signToken } = require('../../server/middlewares/adminAuth');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const familyAdmin = require('../../server/services/familyAdmin');
const { pool } = require('../../server/models/db');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', require('../../server/routes/enrollments'));
  app.use('/api/admin/checkouts', require('../../server/routes/admin/checkouts'));
  app.use('/api/courses', require('../../server/routes/courses'));
  app.use('/api/checkins', require('../../server/routes/checkins'));
  app.use('/api/slots', require('../../server/routes/slots'));
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
const brief = (r) => `${r.status}${r.status >= 400 ? ' ' + JSON.stringify(r.data) : ''}`;

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  step('家庭帳號 × 凍結檔：我的課程、詳情、課表、簽到、預約、匯款證明、取消');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();

  const suffix = hex32().slice(0, 8);
  const digits = String(parseInt(suffix, 16)).padStart(10, '0').slice(-7);
  const venueId = `FZ${suffix.slice(0, 6).toUpperCase()}`;
  const coachId = randomUUID();
  const courseType = 3000000 + (parseInt(suffix.slice(0, 6), 16) % 1000000);
  const mk = (tag, n) => ({ id: randomUUID(), name: `凍結${tag}${suffix}`, phone: `09${n}${digits}`, line_uid: 'U' + hex32() });
  const mom = mk('媽媽', 4);
  const dad = mk('爸爸', 5);
  const stranger = mk('陌生人', 6);
  const kid = { id: randomUUID(), name: `凍結孩子${suffix}`, id_number: `B1${digits}2`, birth_date: '2017-07-07' };
  const created = { enrollments: [], checkouts: [], families: [], slots: [] };
  let zoneId = null;
  let courseTypeCreated = false;
  let periodId = null;
  const prevFlag = process.env.FAMILY_ACCOUNTS_V1;
  process.env.FAMILY_ACCOUNTS_V1 = 'all';

  const token = (p) => signParentToken({ parentId: p.id, phone: p.phone, lineUid: p.line_uid });
  const adminToken = signToken({ sub: randomUUID(), username: 'family-frozen-admin', name: '凍結驗證管理員', role: 'admin' });
  const enroll = async (who) => {
    const r = await call(route.base, 'POST', '/api/enrollments', {
      token: token(who),
      body: {
        coach: { id: coachId, name: `凍結教練${suffix}` },
        venue: { id: venueId, name: `凍結測試館${suffix}` },
        course_type: courseType,
        students: [{ id: kid.id, name: kid.name }],
        period_count: 1,
        request_id: `e2e-frozen-${hex32()}`,
      },
    });
    if (r.data?.enrollment_ids) created.enrollments.push(...r.data.enrollment_ids);
    if (r.data?.checkout_id) created.checkouts.push(r.data.checkout_id);
    return r;
  };
  const mineIds = async (who) => {
    const r = await call(route.base, 'GET', '/api/courses/mine', { token: token(who) });
    return { status: r.status, ids: (r.data || []).flatMap((c) => [c.id, ...(c.sub_order_ids || []), ...(c.enrollment_ids || [])]).filter(Boolean) };
  };

  try {
    zoneId = (await pg.query(
      `INSERT INTO pricing_zones (name, sessions_per_period, sort_order) VALUES ($1, 6, 996) RETURNING id`,
      [`凍結測試區${suffix}`])).rows[0].id;
    await pg.query(`INSERT INTO venues (id, name, is_active, pricing_zone_id) VALUES ($1, $2, TRUE, $3)`,
      [venueId, `凍結測試館${suffix}`, zoneId]);
    await pg.query(
      `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active, pricing_multiplier)
       VALUES ($1, $2, $3, $4, TRUE, 1.00)`,
      [coachId, `凍結教練${suffix}`, `08${digits}8`, `FZ-${suffix}`]);
    await pg.query(`INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2)`, [coachId, venueId]);
    courseTypeCreated = (await pg.query(
      `INSERT INTO course_types (course_type) VALUES ($1) ON CONFLICT DO NOTHING RETURNING course_type`, [courseType])).rowCount > 0;
    await pg.query(
      `INSERT INTO course_type_configs
         (pricing_zone_id, course_type, label, min_students, max_students, sort_order, base_price, is_active)
       VALUES ($2, $1, '凍結測試一對一', 1, 1, 996, 3000, TRUE)`,
      [courseType, zoneId]);
    for (const p of [mom, dad, stranger]) {
      await pg.query(`INSERT INTO parents (id, name, phone, line_uid, is_active) VALUES ($1, $2, $3, $4, TRUE)`,
        [p.id, p.name, p.phone, p.line_uid]);
    }
    await pg.query(
      `INSERT INTO students (id, parent_id, name, id_number, birth_date, is_active, ragic_record_id)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
      [kid.id, mom.id, kid.name, kid.id_number, kid.birth_date, `fz-e2e-${suffix}`]);
    const fc = await pool.connect();
    try {
      await fc.query('BEGIN');
      const fam = await familyAdmin.createFamily(fc, { ownerParentId: mom.id, ownerRelationship: 'mother', actor: 'e2e' });
      created.families.push(fam.result.id);
      await familyAdmin.addMember(fc, { familyId: fam.result.id, parentId: dad.id, relationship: 'father', actor: 'e2e' });
      await fc.query('COMMIT');
    } catch (e) { await fc.query('ROLLBACK'); throw e; } finally { fc.release(); }

    // 媽媽買的課 → 對帳開通（課程期 periodId）
    const paid = await enroll(mom);
    assert(paid.status === 201, `前置：媽媽報名 ${brief(paid)}`);
    const rec = await call(route.base, 'POST', `/api/admin/checkouts/${paid.data.checkout_id}/reconcile`, {
      token: adminToken, body: { invoice_number: 'FZ12345678', invoice_image_url: '/uploads/e2e-frozen-invoice.png' },
    });
    assert(rec.status === 200, `前置：對帳 ${brief(rec)}`);
    periodId = (await pg.query(`SELECT id FROM course_periods WHERE admin_enrollment_id = $1`, [paid.data.enrollment_ids[0]])).rows[0]?.id;
    assert(!!periodId, '前置：課程期已開通');
    const paidId = paid.data.enrollment_ids[0];
    // 媽媽另外兩張未付款的單（匯款證明、成員取消用）＋爸爸替孩子下的一張（擁有者取消用）
    const momPending = await enroll(mom);
    const momPending2 = await enroll(mom);
    const dadPending = await enroll(dad);
    assert([momPending, momPending2, dadPending].every((r) => r.status === 201), '前置：未付款訂單 201');

    // 1
    const dadMine = await mineIds(dad);
    const strangerMine = await mineIds(stranger);
    assert(dadMine.status === 200 && dadMine.ids.includes(paidId), `1. 爸爸的「我的課程」看得到媽媽買的課（${dadMine.status}）`);
    assert(!strangerMine.ids.includes(paidId), '1. 陌生人看不到');

    // 2
    const dadDetail = await call(route.base, 'GET', `/api/courses/${paidId}`, { token: token(dad) });
    assert(dadDetail.status === 200, `2. 爸爸看課程詳情 ${brief(dadDetail)}`);
    assert((dadDetail.data.students_detail || dadDetail.data.students || []).some((s) => (s.id || s) === kid.id || s.name === kid.name),
      '2. 詳情裡的孩子名單含家人的孩子');
    const strangerDetail = await call(route.base, 'GET', `/api/courses/${paidId}`, { token: token(stranger) });
    assert(strangerDetail.status === 403, `2. 陌生人看詳情 403（實際 ${strangerDetail.status}）`);

    // 3
    const sessionId = (await pg.query(
      `INSERT INTO course_sessions (course_period_id, scheduled_at, status, duration_minutes)
       VALUES ($1, NOW() + INTERVAL '2 hours', 'confirmed', 60) RETURNING id`, [periodId])).rows[0].id;
    const dadLessons = await call(route.base, 'GET', '/api/courses/lessons', { token: token(dad) });
    assert(dadLessons.status === 200 && (dadLessons.data || []).some((l) => l.session_id === sessionId || l.id === sessionId),
      `3. 爸爸的課表看得到孩子的堂次（${dadLessons.status}）`);
    const strangerLessons = await call(route.base, 'GET', '/api/courses/lessons', { token: token(stranger) });
    assert(!(strangerLessons.data || []).some((l) => l.session_id === sessionId || l.id === sessionId), '3. 陌生人看不到');

    // 8（先驗開關關閉，再做會改資料的簽到／預約）
    process.env.FAMILY_ACCOUNTS_V1 = 'off';
    const offDetail = await call(route.base, 'GET', `/api/courses/${paidId}`, { token: token(dad) });
    const offCheckin = await call(route.base, 'POST', '/api/checkins', { token: token(dad), body: { sessionId, studentId: kid.id } });
    const offSlots = await call(route.base, 'GET', `/api/slots/period/${periodId}`, { token: token(dad) });
    process.env.FAMILY_ACCOUNTS_V1 = 'all';
    assert(offDetail.status === 403 && offCheckin.status === 403 && offSlots.status === 403,
      `8. 開關關閉 → 爸爸回到只看自己（詳情 ${offDetail.status}、簽到 ${offCheckin.status}、預約 ${offSlots.status}）`);

    // 4
    const strangerCheckin = await call(route.base, 'POST', '/api/checkins', { token: token(stranger), body: { sessionId, studentId: kid.id } });
    assert(strangerCheckin.status === 403, `4. 陌生人替別人的孩子簽到 403（實際 ${strangerCheckin.status}）`);
    const dadCheckin = await call(route.base, 'POST', '/api/checkins', { token: token(dad), body: { sessionId, studentId: kid.id } });
    assert(dadCheckin.status === 200 || dadCheckin.status === 201, `4. 爸爸替孩子簽到 ${brief(dadCheckin)}`);
    const by = (await pg.query(
      `SELECT checked_in_by_parent_id FROM checkin_records WHERE course_session_id = $1 AND student_id = $2`, [sessionId, kid.id])).rows[0];
    assert(by && by.checked_in_by_parent_id === dad.id, '4. 簽到人記實際操作的爸爸');

    // 5
    const dadPeriod = await call(route.base, 'GET', `/api/slots/period/${periodId}`, { token: token(dad) });
    assert(dadPeriod.status === 200, `5. 爸爸看得到可預約的課程期 ${brief(dadPeriod)}`);
    const strangerPeriod = await call(route.base, 'GET', `/api/slots/period/${periodId}`, { token: token(stranger) });
    assert(strangerPeriod.status === 403, `5. 陌生人 403（實際 ${strangerPeriod.status}）`);
    const slotId = (await pg.query(
      `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status)
       VALUES ($1, $2, date_trunc('hour', NOW()) + INTERVAL '3 days', 60, 'available') RETURNING id`,
      [coachId, venueId])).rows[0].id;
    created.slots.push(slotId);
    const strangerBook = await call(route.base, 'POST', `/api/slots/${slotId}/book`, { token: token(stranger), body: { course_period_id: periodId } });
    assert(strangerBook.status === 403, `5. 陌生人預約 403（實際 ${strangerBook.status}）`);
    const dadBook = await call(route.base, 'POST', `/api/slots/${slotId}/book`, { token: token(dad), body: { course_period_id: periodId } });
    assert(dadBook.status === 200 || dadBook.status === 201, `5. 爸爸預約教練開放的時段 ${brief(dadBook)}`);

    // 6
    const pendingId = momPending.data.enrollment_ids[0];
    const strangerProof = await call(route.base, 'POST', `/api/courses/${pendingId}/payment-proof`, { token: token(stranger), body: { transfer_last_5: '54321' } });
    assert(strangerProof.status === 403, `6. 陌生人填末 5 碼 403（實際 ${strangerProof.status}）`);
    const dadProof = await call(route.base, 'POST', `/api/courses/${pendingId}/payment-proof`, { token: token(dad), body: { transfer_last_5: '12345' } });
    assert(dadProof.status === 200, `6. 爸爸替媽媽的訂單填末 5 碼 ${brief(dadProof)}`);

    // 7
    const memberCancel = await call(route.base, 'POST', `/api/courses/${momPending2.data.enrollment_ids[0]}/cancel`, { token: token(dad), body: { reason: '測試' } });
    assert(memberCancel.status === 403, `7. 一般成員不能取消別人的單（實際 ${memberCancel.status}）`);
    const ownerCancel = await call(route.base, 'POST', `/api/courses/${dadPending.data.enrollment_ids[0]}/cancel`, { token: token(mom), body: { reason: '測試' } });
    assert(ownerCancel.status === 200, `7. 擁有者可以取消家人的未付款訂單 ${brief(ownerCancel)}`);

    step('PASS: 家庭帳號 × 凍結檔 8 項');
  } finally {
    if (prevFlag === undefined) delete process.env.FAMILY_ACCOUNTS_V1; else process.env.FAMILY_ACCOUNTS_V1 = prevFlag;
    const q = (sql, args) => pg.query(sql, args).catch((e) => console.warn('cleanup:', e.message));
    if (periodId) {
      await q(`DELETE FROM checkin_records WHERE course_session_id IN (SELECT id FROM course_sessions WHERE course_period_id = $1)`, [periodId]);
      await q(`DELETE FROM course_sessions WHERE course_period_id = $1`, [periodId]);
    }
    await q(`DELETE FROM coach_availability_slots WHERE id = ANY($1::uuid[]) OR coach_id = $2`, [created.slots, coachId]);
    await q(`DELETE FROM promotion_usages WHERE admin_enrollment_id = ANY($1::text[])`, [created.enrollments]);
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
