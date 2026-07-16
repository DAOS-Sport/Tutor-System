/*
 * 試上課程全鏈 e2e：
 *   F-A07 trial_enabled gate → LIFF 建單（order_kind='trial'、on_site、F-A07 trial_price 快照）
 *   → F-M02 checkout 對帳（發票必填、total_sessions=1）→ 自動開通 course_period
 *     （1 堂、is_experience_course、checkin_mode='self'）→ /mine 續報資料契約
 *   → 自助簽到（1/1）→ 後台簽到清單試上標記 → 堂數上限 NO_SESSIONS_LEFT
 *   → 退費預覽走單筆公式（不誤入家庭共班整批分支）。
 * 比照 enrollment_idempotency.js：in-process 掛 router、隔離 fixture、finally 全清理。
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const { signToken: signAdminToken } = require('../../server/middlewares/adminAuth');
const enrollmentRouter = require('../../server/routes/enrollments');
const coursesRouter = require('../../server/routes/courses');
const checkinsRouter = require('../../server/routes/checkins');
const adminEnrollmentRouter = require('../../server/routes/admin/enrollments');
const adminCheckoutsRouter = require('../../server/routes/admin/checkouts');
const adminCheckinsRouter = require('../../server/routes/admin/checkins');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/courses', coursesRouter);
  app.use('/api/checkins', checkinsRouter);
  app.use('/api/admin/enrollments', adminEnrollmentRouter);
  app.use('/api/admin/checkouts', adminCheckoutsRouter);
  app.use('/api/admin/checkins', adminCheckinsRouter);
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
  const parentId = randomUUID();
  const studentId = randomUUID();
  const phone = `09${String(parseInt(suffix.slice(0, 8), 16)).padStart(8, '0').slice(-8)}`;
  const TRIAL_PRICE = 1502; // 刻意非整千，證明價格來自 F-A07 config 而非推算/舊設定
  let cfg1Orig = null;
  let cfg2Orig = null;

  try {
    const reference = await pg.query(
      `SELECT c.id AS coach_id, v.id AS venue_id
         FROM coaches c CROSS JOIN venues v
        WHERE c.is_active = TRUE
          AND COALESCE(c.is_placeholder, FALSE) = FALSE
          AND v.is_active = TRUE
        ORDER BY c.created_at, v.id
        LIMIT 1`
    );
    if (!reference.rowCount) throw new Error('test database needs one active non-placeholder coach and venue');
    const { coach_id: coachId, venue_id: venueId } = reference.rows[0];
    const adminActor = (await pg.query(
      `SELECT id, username, name FROM admin_users WHERE is_active = TRUE ORDER BY created_at, id LIMIT 1`
    )).rows[0];
    if (!adminActor) throw new Error('test database needs one active admin user');

    // F-A07 試上設定 fixture：ct=1 開試上（自訂價）、ct=2 關試上；原值於 finally 還原。
    cfg1Orig = (await pg.query(`SELECT trial_enabled, trial_price FROM course_type_configs WHERE course_type = 1`)).rows[0] || null;
    cfg2Orig = (await pg.query(`SELECT trial_enabled, trial_price FROM course_type_configs WHERE course_type = 2`)).rows[0] || null;
    if (!cfg1Orig || !cfg2Orig) throw new Error('test database needs course_type_configs rows 1 and 2');
    await pg.query(`UPDATE course_type_configs SET trial_enabled = TRUE, trial_price = $1 WHERE course_type = 1`, [TRIAL_PRICE]);
    await pg.query(`UPDATE course_type_configs SET trial_enabled = FALSE WHERE course_type = 2`);

    // 家長須帶 line_uid（非 demo 前綴）才會被 ensureSoloCoursePeriod 自動開通課期。
    await pg.query(
      `INSERT INTO parents (id, phone, name, line_uid, is_active)
       VALUES ($1,$2,$3,$4,TRUE)`,
      [parentId, phone, `E2E trial parent ${suffix}`, `e2etrial_${suffix}`]
    );
    await pg.query(
      `INSERT INTO students (id, parent_id, name, is_active) VALUES ($1,$2,$3,TRUE)`,
      [studentId, parentId, `E2E trial student ${suffix}`]
    );
    const token = signParentToken({ parentId, phone });
    const adminToken = signAdminToken({
      sub: adminActor.id, username: adminActor.username, name: adminActor.name,
      role: 'admin', venue_ids: [],
    });

    step('F-A07 gate：未開試上的品項拒絕試上下單（fail-closed）');
    const gate = await call(route.base, 'POST', '/api/enrollments', token, {
      request_id: `e2e-trialgate-${suffix}`,
      coach: { id: coachId }, venue: { id: venueId },
      course_type: 2, students: [{ id: studentId }], period_count: 1,
      order_kind: 'trial', payment_method: 'on_site',
    }, { 'Idempotency-Key': `e2e-trialgate-${suffix}` });
    assert(gate.status === 400 && gate.data?.code === 'TRIAL_NOT_ENABLED',
      `未開試上品項被擋 TRIAL_NOT_ENABLED（${gate.status} ${gate.data?.code}）`);

    step('試上建單：order_kind=trial、on_site、快照 F-A07 trial_price');
    const createKey = `e2e-trialchain-${suffix}`;
    const created = await call(route.base, 'POST', '/api/enrollments', token, {
      request_id: createKey,
      coach: { id: coachId }, venue: { id: venueId },
      course_type: 1, students: [{ id: studentId }], period_count: 1,
      order_kind: 'trial', payment_method: 'on_site',
    }, { 'Idempotency-Key': createKey });
    assert(created.status === 201 && created.data?.checkout_id, `試上建單成功（${created.status}）`);
    const checkoutId = created.data.checkout_id;
    const enrollmentId = created.data.enrollment_ids?.[0];
    assert(!!enrollmentId, '回應含 enrollment id');
    const orderRow = (await pg.query(
      `SELECT order_kind, payment_method, total_sessions, original_price::float8 AS original_price,
              final_price::float8 AS final_price, status
         FROM admin_enrollments WHERE id = $1`, [enrollmentId]
    )).rows[0];
    assert(orderRow.order_kind === 'trial' && orderRow.payment_method === 'on_site' && orderRow.total_sessions === 1,
      `訂單為試上/現場付費/1 堂（${orderRow.order_kind}/${orderRow.payment_method}/${orderRow.total_sessions}）`);
    assert(orderRow.original_price === TRIAL_PRICE && orderRow.final_price === TRIAL_PRICE,
      `價格快照＝F-A07 trial_price ${TRIAL_PRICE}（實際 ${orderRow.original_price}/${orderRow.final_price}）`);
    assert(orderRow.status === 'pending_payment', `初始 status=pending_payment（${orderRow.status}）`);

    step('F-M02 checkout 對帳：發票必填、total=1、自動開通 1 堂試上課期');
    const noInvoice = await call(route.base, 'POST', `/api/admin/checkouts/${checkoutId}/reconcile`, adminToken, {});
    assert(noInvoice.status === 400, `未附發票被擋（${noInvoice.status}）`);
    const reconciled = await call(route.base, 'POST', `/api/admin/checkouts/${checkoutId}/reconcile`, adminToken, {
      invoice_number: 'AB12345678',
      invoice_image_url: `https://example.com/e2e-invoice-${suffix}.jpg`,
    });
    assert(reconciled.status === 200, `對帳通過（${reconciled.status} ${JSON.stringify(reconciled.data || {}).slice(0, 120)}）`);
    const afterRec = (await pg.query(
      `SELECT ae.status, ae.total_sessions, ae.invoice_number, ae.invoice_issued_at,
              cs.payment_status
         FROM admin_enrollments ae
         JOIN checkout_sessions cs ON cs.checkout_id = ae.checkout_id
        WHERE ae.id = $1`, [enrollmentId]
    )).rows[0];
    assert(afterRec.status === 'confirmed' && afterRec.total_sessions === 1,
      `對帳後 confirmed 且維持 1 堂（${afterRec.status}/${afterRec.total_sessions}）`);
    assert(afterRec.invoice_number === 'AB12345678' && !!afterRec.invoice_issued_at, '發票號碼＋開票時間已回填');
    assert(afterRec.payment_status === 'paid', `checkout 轉 paid（${afterRec.payment_status}）`);
    const period = (await pg.query(
      `SELECT cp.id, cp.total_sessions, cp.used_sessions, cp.is_experience_course, cp.checkin_mode, cp.status::text AS status
         FROM course_periods cp WHERE cp.admin_enrollment_id = $1`, [enrollmentId]
    )).rows[0];
    assert(!!period, '自動開通 course_period');
    assert(period.total_sessions === 1 && period.is_experience_course === true
      && period.checkin_mode === 'self' && period.status === 'active',
      `課期為 1 堂/試上標記/self 簽到/active（${period.total_sessions}/${period.is_experience_course}/${period.checkin_mode}/${period.status}）`);
    const cpe = await pg.query(
      `SELECT 1 FROM course_period_enrollments WHERE course_period_id = $1 AND student_id = $2 AND status = 'active'`,
      [period.id, studentId]
    );
    assert(cpe.rowCount === 1, '學員已掛入課期名單');

    step('/mine 續報資料契約：order_kind + coach.id + venue.id + course_type 齊備');
    const mine1 = await call(route.base, 'GET', '/api/courses/mine', token);
    const card1 = (mine1.data || []).find((c) => c.id === enrollmentId);
    assert(!!card1, '/mine 回傳試上卡');
    assert(card1.order_kind === 'trial', `卡片 order_kind=trial（${card1.order_kind}）`);
    assert(card1.lifecycle === 'active' && card1.checkin_mode === 'self',
      `對帳後 lifecycle=active、self 模式（${card1.lifecycle}/${card1.checkin_mode}）`);
    assert(card1.coach?.id === coachId && (card1.venue?.id || card1.venue_id) === venueId && Number(card1.course_type) === 1,
      '續報按鈕所需 coach.id/venue.id/course_type 齊備');

    step('自助簽到：1/1 簽到成功、記錄落地');
    const checkin = await call(route.base, 'POST', '/api/checkins/self', token, {
      course_period_id: period.id, student_ids: [studentId],
    });
    assert(checkin.status === 201 && checkin.data?.ok === true, `自助簽到成功（${checkin.status}）`);
    assert(Number(checkin.data.remaining_sessions) === 0 && Number(checkin.data.used_sessions) === 1,
      `簽到後 1/1、剩 0 堂（used=${checkin.data.used_sessions} remaining=${checkin.data.remaining_sessions}）`);
    const sessionId = checkin.data.session_id;
    const landed = (await pg.query(
      `SELECT cs.status::text AS status, cs.created_via,
              (SELECT COUNT(*)::int FROM checkin_records cr
                WHERE cr.course_session_id = cs.id AND cr.attendance_status = 'ATTENDED') AS attended,
              (SELECT used_sessions FROM course_periods WHERE id = $2) AS period_used,
              (SELECT used_sessions FROM admin_enrollments WHERE id = $3) AS order_used
         FROM course_sessions cs WHERE cs.id = $1`, [sessionId, period.id, enrollmentId]
    )).rows[0];
    assert(landed.status === 'completed' && landed.created_via === 'self_checkin' && landed.attended === 1,
      `課堂 completed/self_checkin/1 筆出席（${landed.status}/${landed.created_via}/${landed.attended}）`);
    assert(Number(landed.period_used) === 1 && Number(landed.order_used) === 1, 'used_sessions 鏡射 period+order 皆為 1');

    step('後台簽到清單：試上標記 is_experience_course=true');
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 台北日期
    const adminList = await call(route.base, 'GET', `/api/admin/checkins?date=${today}`, adminToken);
    const listRow = (adminList.data || []).find((r) => r.session_id === sessionId);
    assert(!!listRow, '簽到清單含本次簽到');
    assert(listRow.is_experience_course === true && listRow.session_created_via === 'self_checkin',
      `清單標記試上＋自助（${listRow.is_experience_course}/${listRow.session_created_via}）`);

    step('簽完 1/1 → lifecycle=completed（續報入口保留於前端 completed 卡）');
    const mine2 = await call(route.base, 'GET', '/api/courses/mine', token);
    const card2 = (mine2.data || []).find((c) => c.id === enrollmentId);
    assert(card2?.lifecycle === 'completed', `試上簽完轉 completed（${card2?.lifecycle}）`);

    step('堂數上限：釋放當日名額後再簽被 NO_SESSIONS_LEFT 擋');
    // 模擬「隔天再簽」：把當日冪等/跨模式/今日課堂重用三道守門用的日期戳全部往前挪一天，
    // 讓請求直達容量守門（scheduled_at 不挪會命中「簽進今日既有課堂」的過渡保護分支）。
    await pg.query(
      `UPDATE course_sessions
          SET self_checkin_date = self_checkin_date - 1,
              scheduled_at = scheduled_at - INTERVAL '1 day'
        WHERE id = $1`, [sessionId]
    );
    await pg.query(`UPDATE checkin_records SET checked_in_at = checked_in_at - INTERVAL '1 day' WHERE course_session_id = $1`, [sessionId]);
    const overCap = await call(route.base, 'POST', '/api/checkins/self', token, {
      course_period_id: period.id, student_ids: [studentId],
    });
    assert(overCap.status === 409 && overCap.data?.code === 'NO_SESSIONS_LEFT',
      `第二堂被擋 NO_SESSIONS_LEFT（${overCap.status} ${overCap.data?.code}）`);

    step('退費預覽：試上不誤入家庭共班整批分支、1/1 用畢退 0');
    const preview = await call(route.base, 'GET', `/api/admin/enrollments/${enrollmentId}/refund-preview`, adminToken);
    assert(preview.status === 200, `退費預覽 200（${preview.status}）`);
    assert(preview.data?.family_shared !== true, '試上不觸發家庭共班整批退費分支');
    assert(Number(preview.data?.total) === 1 && Number(preview.data?.used) === 1 && Number(preview.data?.refund_amount) === 0,
      `1/1 用畢退 0（total=${preview.data?.total} used=${preview.data?.used} refund=${preview.data?.refund_amount}）`);

    step('PASS: 試上全鏈（gate→建單→對帳開通→續報契約→簽到→標記→上限→退費防禦）全數通過');
  } finally {
    await pg.query(`DELETE FROM checkin_records WHERE course_session_id IN (
        SELECT cs.id FROM course_sessions cs JOIN course_periods cp ON cp.id = cs.course_period_id
        WHERE cp.admin_enrollment_id LIKE 'CP%' AND cp.admin_enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = $1)
           OR cp.admin_enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = $1))`, [phone]).catch(() => {});
    await pg.query(`DELETE FROM course_sessions WHERE course_period_id IN (
        SELECT id FROM course_periods WHERE admin_enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = $1))`, [phone]).catch(() => {});
    await pg.query(`DELETE FROM course_period_enrollments WHERE course_period_id IN (
        SELECT id FROM course_periods WHERE admin_enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = $1))`, [phone]).catch(() => {});
    await pg.query(`DELETE FROM course_periods WHERE admin_enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = $1)`, [phone]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = $1)`, [phone]).catch(() => {});
    await pg.query(`DELETE FROM checkout_invoices WHERE checkout_id IN (SELECT checkout_id FROM checkout_sessions WHERE parent_id = $1)`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE parent_phone = $1`, [phone]).catch(() => {});
    await pg.query(`DELETE FROM request_idempotency_ledger WHERE actor_type = 'parent' AND actor_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM checkout_sessions WHERE parent_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE id = $1`, [studentId]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = $1`, [parentId]).catch(() => {});
    if (cfg1Orig) {
      await pg.query(`UPDATE course_type_configs SET trial_enabled = $1, trial_price = $2 WHERE course_type = 1`,
        [cfg1Orig.trial_enabled, cfg1Orig.trial_price]).catch(() => {});
    }
    if (cfg2Orig) {
      await pg.query(`UPDATE course_type_configs SET trial_enabled = $1, trial_price = $2 WHERE course_type = 2`,
        [cfg2Orig.trial_enabled, cfg2Orig.trial_price]).catch(() => {});
    }
    await pg.end().catch(() => {});
    await route.close().catch(() => {});
  }

  step('trial full chain cleanup complete');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
