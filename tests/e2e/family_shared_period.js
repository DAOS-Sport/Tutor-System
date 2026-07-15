/*
 * U12 家庭共班整合測試（真實 routes + 真實 PostgreSQL，隔離資料、finally 清理）。
 *
 * 情境 A（本次修復）：同一家長 3 位小孩報名「一對三」1 期 →
 *   - 前兩筆對帳完成時「不」開課（共用開通守門）
 *   - 第三筆對帳完成 → 恰好「一個」共用 course_period（6 堂、3 位學員、金額=兄弟訂單加總）
 *   - /api/courses/mine 合併成一張卡（3 位學員、6 堂、sub_order_count=3）
 * 情境 B（行為守恆）：同一家長 2 位小孩報名「一對一」1 期 →
 *   - 兩筆各自開獨立 course_period（各 6 堂），不合併
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signToken } = require('../../server/middlewares/adminAuth');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const enrollmentsRouter = require('../../server/routes/enrollments');
const adminEnrollmentsRouter = require('../../server/routes/admin/enrollments');
const coursesRouter = require('../../server/routes/courses');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', enrollmentsRouter);
  app.use('/api/admin/enrollments', adminEnrollmentsRouter);
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
  step('U12 family shared period: 一對三 3 生 1 期 → 一個共用 period；一對一 2 生不合併');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();

  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const venueId = `Z${suffix.slice(0, 3).toUpperCase()}`;
  const parentId = randomUUID();
  const coachId = randomUUID();
  const CT_GROUP = 9301; // 測試專用課型：一對三
  const CT_SOLO = 9302;  // 測試專用課型：一對一
  const batchIds = [];
  const allEnrollmentIds = [];
  const checkoutIds = [];

  try {
    // ── 隔離種子資料 ─────────────────────────────────────────────
    await pg.query(`INSERT INTO venues (id, name, is_active) VALUES ($1, $2, TRUE)`, [venueId, `e2e館${suffix}`]);
    await pg.query(
      `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active, pricing_multiplier)
       VALUES ($1, $2, $3, $4, TRUE, 1.00)`,
      [coachId, `e2e教練${suffix}`, `0955${suffix.replace(/\D/g, '2').padEnd(6, '3').slice(0, 6)}`, `E2E-${suffix}`]
    );
    await pg.query(`INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2)`, [coachId, venueId]);
    await pg.query(
      `INSERT INTO parents (id, name, phone, line_uid, is_active)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [parentId, `e2e家長${suffix}`, `09${suffix.replace(/\D/g, '1').padEnd(8, '7').slice(0, 8)}`, `Ue2e${suffix}${'0'.repeat(20)}`]
    );
    const studentIds = [];
    for (const n of ['大寶', '二寶', '三寶']) {
      const r = await pg.query(
        `INSERT INTO students (parent_id, name) VALUES ($1, $2) RETURNING id`,
        [parentId, `e2e${n}${suffix}`]
      );
      studentIds.push(r.rows[0].id);
    }
    await pg.query(
      `INSERT INTO course_type_configs (course_type, label, min_students, max_students, sort_order, base_price, is_active)
       VALUES ($1, 'e2e一對三', 1, 3, 990, 3000, TRUE), ($2, 'e2e一對一', 1, 1, 991, 9000, TRUE)`,
      [CT_GROUP, CT_SOLO]
    );

    const parentRow = await pg.query(`SELECT phone, line_uid FROM parents WHERE id = $1`, [parentId]);
    const parentToken = signParentToken({ parentId, phone: parentRow.rows[0].phone, lineUid: parentRow.rows[0].line_uid });
    const adminToken = signToken({ sub: randomUUID(), username: 'e2e-admin', name: 'e2e-admin', role: 'admin' });

    const enroll = async (courseType, students, tag, periodCount = 1) => {
      const created = await call(route.base, 'POST', '/api/enrollments', {
        token: parentToken,
        body: {
          coach: { id: coachId, name: `e2e教練${suffix}` },
          venue: { id: venueId, name: `e2e館${suffix}` },
          course_type: courseType,
          students: students.map((id, i) => ({ id, name: `s${i}` })),
          period_count: periodCount,
          request_id: `e2e-u12-${tag}-${suffix}-${Date.now()}`,
        },
      });
      assert(created.status === 201, `${tag} enrollment create 201，實際 ${created.status} ${JSON.stringify(created.data)}`);
      batchIds.push(created.data.batch_id);
      allEnrollmentIds.push(...created.data.enrollment_ids);
      checkoutIds.push(created.data.checkout_id);
      return created.data;
    };
    const reconcile = async (enrollmentId) => call(route.base, 'POST', `/api/admin/enrollments/${enrollmentId}/reconcile`, {
      token: adminToken,
      body: { invoice_number: 'AB12345678', invoice_image_url: '/uploads/e2e-invoice.png' },
    });

    // ── 情境 A：一對三 × 3 生 × 1 期 ─────────────────────────────
    const groupOrder = await enroll(CT_GROUP, studentIds, 'group');
    assert(groupOrder.count === 3, `一對三 3 生拆 3 筆子訂單，實際 ${groupOrder.count}`);
    const [g1, g2, g3] = groupOrder.enrollment_ids;

    for (const id of [g1, g2]) {
      const r = await reconcile(id);
      assert(r.status === 200, `reconcile ${id} 200，實際 ${r.status} ${JSON.stringify(r.data)}`);
    }
    let periods = await pg.query(
      `SELECT id FROM course_periods WHERE enrollment_batch_id = $1 OR admin_enrollment_id = ANY($2::text[])`,
      [groupOrder.batch_id, groupOrder.enrollment_ids]
    );
    assert(periods.rowCount === 0, `前 2 筆對帳完成時尚不開課（守門），實際 ${periods.rowCount} 個 period`);

    const r3 = await reconcile(g3);
    assert(r3.status === 200, `reconcile ${g3} 200，實際 ${r3.status}`);
    periods = await pg.query(
      `SELECT id, total_sessions, original_price::int AS op, final_price::int AS fp,
              enrollment_batch_id, period_number, admin_enrollment_id
         FROM course_periods WHERE enrollment_batch_id = $1 OR admin_enrollment_id = ANY($2::text[])`,
      [groupOrder.batch_id, groupOrder.enrollment_ids]
    );
    assert(periods.rowCount === 1, `全員對帳後恰好 1 個共用 period，實際 ${periods.rowCount}`);
    const period = periods.rows[0];
    assert(period.total_sessions === 6, `共用 period 總堂數 6（非 18），實際 ${period.total_sessions}`);
    assert(period.fp === 9000, `共用 period 金額 = 3 筆加總 9000，實際 ${period.fp}`);
    assert(period.enrollment_batch_id === groupOrder.batch_id && period.period_number === 1, 'period 掛上 batch + 期別');
    const bound = await pg.query(
      `SELECT COUNT(*)::int AS n FROM course_period_enrollments WHERE course_period_id = $1 AND status = 'active'`,
      [period.id]
    );
    assert(bound.rows[0].n === 3, `3 位學員都綁進共用 period，實際 ${bound.rows[0].n}`);

    // /mine 顯示合併：一張卡、3 位學員、6 堂
    const mine = await call(route.base, 'GET', '/api/courses/mine', { token: parentToken });
    assert(mine.status === 200, `courses/mine 200，實際 ${mine.status}`);
    const groupCards = mine.data.filter((x) => x.course_period_id === period.id);
    assert(groupCards.length === 1, `我的課程只顯示 1 張共班卡，實際 ${groupCards.length}`);
    const card = groupCards[0];
    assert(card.total_sessions === 6 && card.remaining_sessions === 6, `共班卡 6 堂，實際 ${card.total_sessions}`);
    assert((card.students || []).length === 3, `共班卡列出 3 位學員，實際 ${(card.students || []).length}`);
    assert(card.sub_order_count === 3, `共班卡標示 3 筆子訂單，實際 ${card.sub_order_count}`);
    assert(Number(card.final_price) === 9000, `共班卡金額 9000，實際 ${card.final_price}`);

    // 明細端點：任一兄弟訂單 id 都解析到同一共用 period
    for (const id of groupOrder.enrollment_ids) {
      const detail = await call(route.base, 'GET', `/api/courses/${id}`, { token: parentToken });
      assert(detail.status === 200 && detail.data.course_period_id === period.id,
        `明細 ${id} 解析到共用 period，實際 ${detail.data && detail.data.course_period_id}`);
      assert(detail.data.total_sessions === 6, `明細 ${id} 顯示 6 堂，實際 ${detail.data.total_sessions}`);
    }

    // ── 情境 A2：一對二 × 2 生 × 2 期 → 4 財務列、2 份共享期別、總計 12 堂 ──
    const twoByTwoOrder = await enroll(CT_GROUP, studentIds.slice(0, 2), 'two-by-two', 2);
    assert(twoByTwoOrder.count === 4, `一對二兩期保留 2 生 × 2 期 = 4 筆財務列，實際 ${twoByTwoOrder.count}`);
    for (const id of twoByTwoOrder.enrollment_ids) {
      const reconciled = await reconcile(id);
      assert(reconciled.status === 200, `two-by-two reconcile ${id} 200，實際 ${reconciled.status}`);
    }
    const twoByTwoPeriods = await pg.query(
      `SELECT cp.id, cp.period_number, cp.total_sessions,
              COUNT(cpe.student_id) FILTER (WHERE cpe.status = 'active')::int AS participant_count
         FROM course_periods cp
         LEFT JOIN course_period_enrollments cpe ON cpe.course_period_id = cp.id
        WHERE cp.enrollment_batch_id = $1
        GROUP BY cp.id
        ORDER BY cp.period_number`,
      [twoByTwoOrder.batch_id]
    );
    assert(twoByTwoPeriods.rowCount === 2, `四筆財務列只建立兩個共享期別，實際 ${twoByTwoPeriods.rowCount}`);
    assert(twoByTwoPeriods.rows.every((row) => row.total_sessions === 6 && row.participant_count === 2),
      '每一期各 6 堂且共同掛兩位學生');
    assert(twoByTwoPeriods.rows.reduce((sum, row) => sum + row.total_sessions, 0) === 12,
      '兩期共享權益總堂數為 12，未乘入 4 筆 registration');
    const twoByTwoCards = (await call(route.base, 'GET', '/api/courses/mine', { token: parentToken })).data
      .filter((row) => row.enrollment_batch_id === twoByTwoOrder.batch_id);
    assert(twoByTwoCards.length === 2 && twoByTwoCards.every((row) => row.students?.length === 2),
      `手動扣課/我的課程資料源按 entitlement 顯示兩張共享期別卡，實際 ${twoByTwoCards.length}`);

    // ── 情境 B：一對一 × 2 生 × 1 期 → 各自獨立 period ───────────
    const soloOrder = await enroll(CT_SOLO, studentIds.slice(0, 2), 'solo');
    assert(soloOrder.count === 2, `一對一 2 生拆 2 筆子訂單，實際 ${soloOrder.count}`);
    for (const id of soloOrder.enrollment_ids) {
      const r = await reconcile(id);
      assert(r.status === 200, `solo reconcile ${id} 200，實際 ${r.status}`);
    }
    const soloPeriods = await pg.query(
      `SELECT id, total_sessions, enrollment_batch_id FROM course_periods
        WHERE admin_enrollment_id = ANY($1::text[])`,
      [soloOrder.enrollment_ids]
    );
    assert(soloPeriods.rowCount === 2, `一對一 2 生開 2 個獨立 period，實際 ${soloPeriods.rowCount}`);
    assert(soloPeriods.rows.every((row) => row.total_sessions === 6 && row.enrollment_batch_id === null),
      '一對一 period 各 6 堂且不掛 batch（不合併）');

    // 超額守門：一對三帶 4 位學員（3+1 重複借用一位）→ 應被拒
    // 需要第 4 位學員才能觸發（3 位學員時 studentCount=3 未超額）
    const extra = await pg.query(
      `INSERT INTO students (parent_id, name) VALUES ($1, $2) RETURNING id`,
      [parentId, `e2e四寶${suffix}`]
    );
    studentIds.push(extra.rows[0].id);
    const over = await call(route.base, 'POST', '/api/enrollments', {
      token: parentToken,
      body: {
        coach: { id: coachId, name: 'x' },
        venue: { id: venueId, name: 'x' },
        course_type: CT_GROUP,
        students: studentIds.map((id) => ({ id, name: 'x' })),
        period_count: 1,
        request_id: `e2e-u12-over-${suffix}-${Date.now()}`,
      },
    });
    assert(over.status === 400 && over.data.code === 'STUDENT_COUNT_EXCEEDS_COURSE_TYPE',
      `一對三帶 4 生應被拒（STUDENT_COUNT_EXCEEDS_COURSE_TYPE），實際 ${over.status} ${over.data && over.data.code}`);

    // ── 情境 C：家庭共班退費＝整班整期 ───────────────────────────
    // 先排一堂未來課占用教練時段，驗證退費會取消課堂並釋出時段。
    const slot = await pg.query(
      `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, status)
       VALUES ($1, $2, NOW() + interval '2 days', 'booked') RETURNING id`,
      [coachId, venueId]
    );
    const futureSession = await pg.query(
      `INSERT INTO course_sessions (course_period_id, availability_slot_id, scheduled_at, status)
       VALUES ($1, $2, NOW() + interval '2 days', 'confirmed') RETURNING id`,
      [period.id, slot.rows[0].id]
    );
    await pg.query(`UPDATE coach_availability_slots SET booked_session_id = $2 WHERE id = $1`,
      [slot.rows[0].id, futureSession.rows[0].id]);

    const rp = await call(route.base, 'GET', `/api/admin/enrollments/${g2}/refund-preview`, { token: adminToken });
    assert(rp.status === 200 && rp.data.family_shared === true, `退費預覽標示 family_shared，實際 ${rp.status} ${JSON.stringify(rp.data && rp.data.family_shared)}`);
    assert((rp.data.sibling_ids || []).length === 3, `預覽涵蓋 3 筆兄弟訂單，實際 ${(rp.data.sibling_ids || []).length}`);
    assert(rp.data.total === 6 && rp.data.used === 0, `預覽以共用 period 堂數計（6 總 0 已用），實際 ${rp.data.total}/${rp.data.used}`);

    const refund = await call(route.base, 'POST', `/api/admin/enrollments/${g2}/refund`, {
      token: adminToken, body: { reason: 'e2e 整期退費' },
    });
    assert(refund.status === 200 && refund.data.family_shared === true, `整期退費 200，實際 ${refund.status}`);
    assert((refund.data.refunded_enrollment_ids || []).length === 3, `3 筆兄弟訂單一起退，實際 ${(refund.data.refunded_enrollment_ids || []).length}`);
    assert(Number(refund.data.refund_amount) === Number(rp.data.refund_amount), `退費總額與預覽一致，實際 ${refund.data.refund_amount} vs ${rp.data.refund_amount}`);
    const refundedRows = await pg.query(
      `SELECT COUNT(*)::int AS n FROM admin_enrollments WHERE id = ANY($1::text[]) AND status = 'refunded' AND refund_amount IS NOT NULL`,
      [groupOrder.enrollment_ids]
    );
    assert(refundedRows.rows[0].n === 3, `DB 3 筆皆 refunded 且有退款金額，實際 ${refundedRows.rows[0].n}`);
    const periodAfter = await pg.query(`SELECT status FROM course_periods WHERE id = $1`, [period.id]);
    assert(periodAfter.rows[0].status === 'refunded', `共用 period 轉 refunded，實際 ${periodAfter.rows[0].status}`);
    const sessAfter = await pg.query(`SELECT status FROM course_sessions WHERE id = $1`, [futureSession.rows[0].id]);
    assert(sessAfter.rows[0].status === 'cancelled_normal', `未來課堂已取消，實際 ${sessAfter.rows[0].status}`);
    const slotAfter = await pg.query(`SELECT status, booked_session_id FROM coach_availability_slots WHERE id = $1`, [slot.rows[0].id]);
    assert(slotAfter.rows[0].status === 'available' && slotAfter.rows[0].booked_session_id === null,
      `教練時段已釋出，實際 ${slotAfter.rows[0].status}`);
    const again = await call(route.base, 'POST', `/api/admin/enrollments/${g1}/refund`, {
      token: adminToken, body: { reason: 'e2e 重複退費' },
    });
    assert(again.status === 400, `重複退費被擋（400），實際 ${again.status}`);

    step('PASS: 家庭共班共用 period、顯示合併、一對一守恆、超額守門、整期退費 全數通過');
  } finally {
    await pg.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [allEnrollmentIds]).catch(() => {});
    await pg.query(`UPDATE coach_availability_slots SET booked_session_id = NULL WHERE coach_id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM course_sessions WHERE course_period_id IN (SELECT id FROM course_periods WHERE enrollment_batch_id = ANY($1::uuid[]) OR admin_enrollment_id = ANY($2::text[]))`, [batchIds.filter(Boolean), allEnrollmentIds]).catch(() => {});
    await pg.query(`DELETE FROM coach_availability_slots WHERE coach_id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM checkout_invoices WHERE checkout_id = ANY($1::text[])`, [checkoutIds]).catch(() => {});
    await pg.query(
      `DELETE FROM course_periods WHERE enrollment_batch_id = ANY($1::uuid[]) OR admin_enrollment_id = ANY($2::text[])`,
      [batchIds.filter(Boolean), allEnrollmentIds]
    ).catch(() => {});
    await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [allEnrollmentIds]).catch(() => {});
    await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::text[])`, [checkoutIds]).catch(() => {});
    await pg.query(`DELETE FROM request_idempotency_ledger WHERE actor_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM students WHERE parent_id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = $1`, [parentId]).catch(() => {});
    await pg.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM coaches WHERE id = $1`, [coachId]).catch(() => {});
    await pg.query(`DELETE FROM course_type_configs WHERE course_type IN ($1, $2)`, [CT_GROUP, CT_SOLO]).catch(() => {});
    await pg.query(`DELETE FROM venues WHERE id = $1`, [venueId]).catch(() => {});
    await route.close().catch(() => {});
    await pg.end().catch(() => {});
  }
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
