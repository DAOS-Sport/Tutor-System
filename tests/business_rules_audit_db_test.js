'use strict';
/*
 * D18（GitHub Tutor-System #13）業務規則盤點的後端證據 —— 真的打 API／呼叫 service，不靠讀程式判斷。
 * 盤點表：docs/business_rules_audit_2026-10.md（每一條「後端擋」規則對應下面的步驟代號）。
 *
 * 跑法：TEST_DATABASE_URL=<拋棄式測試庫> npm run test:db（runner 會把 DATABASE_URL 換成測試庫）。
 * 隔離：自建一個定價區＋場館＋教練＋家長，金額與人數都在這組合成資料上驗證，不改既有區的價格；
 * finally 一律清掉自己建的列。唯一的全域副作用是 N 段的人數校正 —— 它本來就是全庫冪等的資料修正，
 * 測的正是「整庫跑完後所有列都等於組別」。
 *
 *   H 人數＝組別：個人報名（一般／試上）一對三、一對六要剛好選滿；團報發起、加入、送審都不能超過或不足。
 *   N 課程需求人數校正：舊列（一對三 min 2、一對六 min 5／max 5）開機校正成組別、寫稽核、冪等；排程生效不寫回舊人數。
 *   P 價格：後端重算（不信前端金額）、教練係數（admin_staff 優先）、級距明價、期數範圍、折價券分攤、試上價。
 *   G 團報價格快照：教練日後調價不改已發起團的每家金額。
 *   R 報名資格：場館停用、組別停用、教練停用、重複學員、別人家的學員。
 *   E 簽到守門（凍結區，唯讀驗證）：來源報名已退費／課期已退費／找不到來源 → 不可簽到或扣課；
 *     退費身分核對：團報訂單缺家長識別、同一家長本期多筆有效 → 不自動退，交人工核對。
 *   T 評價門檻：低於門檻寫告警、同月不重複；評分夾在 1–5、缺項 400、重複送出 409。
 *   X 目前「都沒擋」的現況證據（列給 Owner 決定）：同一學員可重複試上、可重複買同一教練同一組別。
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('需要 TEST_DATABASE_URL'); process.exit(1); }
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');
// 路由透過 models/db 取連線：一律指向同一個測試庫。
process.env.DATABASE_URL = url;

const express = require('../server/node_modules/express');
const { Client } = require('../server/node_modules/pg');
const { signParentToken } = require('../server/middlewares/parentAuth');
const enrollmentRouter = require('../server/routes/enrollments');
const groupOrdersRouter = require('../server/routes/groupOrders');
const { pool } = require('../server/models/db');
const { evaluateSubmitReadiness } = require('../server/services/groupOrderSubmit');
const { assertCourseEntitlement, lockRefundPeriods } = require('../server/services/courseEntitlements');
const { normalizeCourseTypeHeadcounts, AUDIT_ACTION } = require('../server/services/courseTypeHeadcount');
const { applyDueScheduledCourseTypeChanges } = require('../server/services/courseTypeSchedule');
const evaluations = require('../server/services/evaluations');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}
const step = (s) => console.log(`\n▶ ${s}`);

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/group-orders', groupOrdersRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'test route failure' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function call(base, method, path, token, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch { /* 非 JSON */ }
  return { status: response.status, data };
}

(async () => {
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const route = await startRouteServer();

  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const digits = (n) => String(parseInt(suffix.slice(0, 7), 16) + n).padStart(8, '0').slice(-8);
  const venueId = `T${suffix.slice(0, 7)}`.toUpperCase();
  const ragicId = `BRA-${suffix}`;
  const coachId = randomUUID();
  const parentA = randomUUID();
  const parentB = randomUUID();
  const outsider = randomUUID();
  const phoneA = `09${digits(1)}`;
  const phoneB = `09${digits(2)}`;
  const phoneO = `09${digits(3)}`;
  const coupon = `BRA${suffix}`.toUpperCase();
  let zoneId = null;
  let promoId = null;
  const periodIds = [];
  let reqSeq = 0;

  try {
    // ── 合成資料：獨立定價區（每期 6 堂、1–3 期）＋場館＋教練（係數 1.20、未連 admin_staff）──
    zoneId = (await pg.query(
      `INSERT INTO pricing_zones (name, sessions_per_period, period_count_min, period_count_max)
       VALUES ($1, 6, 1, 3) RETURNING id`, [`稽核區${suffix}`])).rows[0].id;
    await pg.query(`INSERT INTO venues (id, name, is_active, pricing_zone_id) VALUES ($1,$2,TRUE,$3)`,
      [venueId, `稽核館${suffix}`, zoneId]);
    await pg.query(
      `INSERT INTO coaches (id, ragic_employee_id, name, phone, pricing_multiplier, is_active)
       VALUES ($1,$2,$3,$4,1.20,TRUE)`, [coachId, ragicId, `稽核教練${suffix}`, `09${digits(9)}`]);
    // 舊列形狀：一對三存 2–3、一對六存 5–5（max 也錯）；一對二存 1–2。
    const cfg = [
      [2, '一對二', 1, 2, 6000],
      [3, '一對三', 2, 3, 4500],
      [6, '一對六', 5, 5, 3000],
    ];
    for (const [ct, label, mn, mx, price] of cfg) {
      await pg.query('INSERT INTO course_types (course_type) VALUES ($1) ON CONFLICT DO NOTHING', [ct]);
      await pg.query(
        `INSERT INTO course_type_configs (pricing_zone_id, course_type, label, min_students, max_students, base_price, is_active, trial_enabled, trial_price)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE,700)`, [zoneId, ct, label, mn, mx, price]);
    }
    await pg.query(
      `INSERT INTO parents (id, phone, name, line_uid, is_active)
       VALUES ($1,$2,$3,$4,TRUE),($5,$6,$7,$8,TRUE),($9,$10,$11,$12,TRUE)`,
      [parentA, phoneA, `稽核家長A${suffix}`, `bra_a_${suffix}`, parentB, phoneB, `稽核家長B${suffix}`, `bra_b_${suffix}`,
        outsider, phoneO, `稽核外人${suffix}`, `bra_o_${suffix}`]);
    const kidsA = [];
    for (let i = 0; i < 7; i += 1) {
      kidsA.push((await pg.query(`INSERT INTO students (parent_id, name, is_active) VALUES ($1,$2,TRUE) RETURNING id`,
        [parentA, `稽核A孩${i}${suffix}`])).rows[0].id);
    }
    const kidsB = [];
    for (let i = 0; i < 3; i += 1) {
      kidsB.push((await pg.query(`INSERT INTO students (parent_id, name, is_active) VALUES ($1,$2,TRUE) RETURNING id`,
        [parentB, `稽核B孩${i}${suffix}`])).rows[0].id);
    }
    const outsiderKid = (await pg.query(`INSERT INTO students (parent_id, name, is_active) VALUES ($1,$2,TRUE) RETURNING id`,
      [outsider, `稽核外人孩${suffix}`])).rows[0].id;
    const tokenA = signParentToken({ parentId: parentA, phone: phoneA });
    const tokenB = signParentToken({ parentId: parentB, phone: phoneB });

    const enroll = (body) => {
      reqSeq += 1;
      const rid = `bra-${suffix}-${reqSeq}`;
      return call(route.base, 'POST', '/api/enrollments', tokenA, {
        request_id: rid, coach: { id: coachId }, venue: { id: venueId }, period_count: 1, ...body,
      }, { 'Idempotency-Key': rid });
    };
    const kids = (n) => kidsA.slice(0, n).map((id) => ({ id }));
    const ordersOf = async (ids) => (await pg.query(
      `SELECT id, original_price::float8 AS original_price, final_price::float8 AS final_price, total_sessions,
              purchased_pricing_multiplier::float8 AS multiplier, payment_method, order_kind
         FROM admin_enrollments WHERE id = ANY($1::text[]) ORDER BY id`, [ids])).rows;
    const checkoutTotal = async (checkoutId) => Number((await pg.query(
      `SELECT total_amount FROM checkout_sessions WHERE checkout_id = $1`, [checkoutId])).rows[0]?.total_amount);

    // ───────────────────────── H 人數＝組別（校正前）─────────────────────────
    step('H1 一對六 max 存成 5（舊列）→ 個人報名 fail-closed：COURSE_CAPACITY_CONFIG_MISMATCH，不建單');
    {
      const r = await enroll({ course_type: 6, students: kids(6) });
      ok(r.status === 409 && r.data?.code === 'COURSE_CAPACITY_CONFIG_MISMATCH', `被擋（${r.status} ${r.data?.code}）`);
    }

    // ───────────────────────── N 課程需求人數校正 ─────────────────────────
    step('N1 開機人數校正 → 本區一對二／三／六全部＝組別，每筆寫一列稽核（操作者 system）');
    {
      const fixed = await normalizeCourseTypeHeadcounts(pool);
      const mine = fixed.filter((f) => f.pricing_zone_id === zoneId).map((f) => f.course_type).sort();
      ok(JSON.stringify(mine) === JSON.stringify([2, 3, 6]), `本區校正 2、3、6（${mine.join(',')}）`);
      const rows = (await pg.query(
        `SELECT course_type, min_students, max_students FROM course_type_configs WHERE pricing_zone_id = $1 ORDER BY course_type`,
        [zoneId])).rows;
      ok(rows.every((r) => r.min_students === r.course_type && r.max_students === r.course_type),
        `min＝max＝組別（${rows.map((r) => `${r.course_type}:${r.min_students}/${r.max_students}`).join(' ')}）`);
      const audits = (await pg.query(
        `SELECT course_type, changes FROM course_type_config_audit_logs
          WHERE pricing_zone_id = $1 AND action = $2 AND by_user = 'system' ORDER BY course_type`, [zoneId, AUDIT_ACTION])).rows;
      ok(audits.length === 3, `稽核 3 列（${audits.length}）`);
      const six = audits.find((a) => a.course_type === 6)?.changes || {};
      ok(six.min_students?.before === 5 && six.min_students?.after === 6 && six.max_students?.before === 5 && six.max_students?.after === 6,
        '一對六稽核記錄 5→6（min 與 max）');
      const three = audits.find((a) => a.course_type === 3)?.changes || {};
      ok(three.min_students?.before === 2 && three.max_students === undefined, '一對三只記 min 2→3（max 本來就對）');
    }
    step('N2 再跑一次 → 全庫 0 筆（冪等），不多寫稽核');
    {
      const again = await normalizeCourseTypeHeadcounts(pool);
      ok(again.length === 0, `第二次校正 0 筆（${again.length}）`);
      const n = Number((await pg.query(
        `SELECT COUNT(*) FROM course_type_config_audit_logs WHERE pricing_zone_id = $1 AND action = $2`, [zoneId, AUDIT_ACTION])).rows[0].count);
      ok(n === 3, `稽核仍是 3 列（${n}）`);
    }
    step('N3 規則上線前排定的排程帶著 min 2／max 2 → 生效時人數仍存組別，其他欄位照常套用');
    {
      await pg.query(
        `UPDATE course_type_configs
            SET pending_changes = '{"min_students":2,"max_students":2,"base_price":4600}'::jsonb,
                scheduled_effective_date = NOW() - INTERVAL '1 minute', scheduled_effective_until = NOW() + INTERVAL '30 days'
          WHERE pricing_zone_id = $1 AND course_type = 3`, [zoneId]);
      await applyDueScheduledCourseTypeChanges(pool);
      const r = (await pg.query(
        `SELECT min_students, max_students, base_price::float8 AS base_price, pending_changes
           FROM course_type_configs WHERE pricing_zone_id = $1 AND course_type = 3`, [zoneId])).rows[0];
      ok(r.min_students === 3 && r.max_students === 3, `一對三仍是 3／3（${r.min_students}/${r.max_students}）`);
      ok(r.base_price === 4600 && r.pending_changes === null, `價格照排程套用、排程清空（${r.base_price}）`);
      await pg.query(`UPDATE course_type_configs SET base_price = 4500 WHERE pricing_zone_id = $1 AND course_type = 3`, [zoneId]);
    }

    // ───────────────────────── H 人數＝組別（個人報名）─────────────────────────
    step('H2 個人報名一對三只選 2 位 → STUDENT_COUNT_MUST_MATCH_COURSE_TYPE');
    {
      const r = await enroll({ course_type: 3, students: kids(2) });
      ok(r.status === 400 && r.data?.code === 'STUDENT_COUNT_MUST_MATCH_COURSE_TYPE', `被擋（${r.status} ${r.data?.code}）`);
    }
    step('H3 個人報名一對六：5 位、7 位都擋；6 位成立（6 筆子訂單）');
    {
      const five = await enroll({ course_type: 6, students: kids(5) });
      ok(five.status === 400 && five.data?.code === 'STUDENT_COUNT_MUST_MATCH_COURSE_TYPE', `5 位被擋（${five.status} ${five.data?.code}）`);
      const seven = await enroll({ course_type: 6, students: kids(7) });
      ok(seven.status === 400 && seven.data?.code === 'STUDENT_COUNT_MUST_MATCH_COURSE_TYPE', `7 位被擋（${seven.status} ${seven.data?.code}）`);
      const six = await enroll({ course_type: 6, students: kids(6) });
      ok(six.status === 201 && (six.data?.enrollment_ids || []).length === 6, `6 位成立（${six.status} ${(six.data?.enrollment_ids || []).length}）`);
    }
    step('H4 試上一對六只選 5 位 → 同樣擋（試上比照正式課）');
    {
      const r = await enroll({ course_type: 6, students: kids(5), order_kind: 'trial', payment_method: 'on_site' });
      ok(r.status === 400 && r.data?.code === 'STUDENT_COUNT_MUST_MATCH_COURSE_TYPE', `被擋（${r.status} ${r.data?.code}）`);
    }

    // ───────────────────────── R 報名資格 ─────────────────────────
    step('R1 重複學員、別人家的學員 → 擋');
    {
      const dup = await enroll({ course_type: 2, students: [{ id: kidsA[0] }, { id: kidsA[0] }] });
      ok(dup.status === 400 && dup.data?.code === 'DUPLICATE_STUDENT', `重複學員被擋（${dup.status} ${dup.data?.code}）`);
      const foreign = await enroll({ course_type: 2, students: [{ id: kidsA[0] }, { id: outsiderKid }] });
      ok(foreign.status === 403 && foreign.data?.code === 'STUDENT_NOT_AVAILABLE', `別人家學員被擋（${foreign.status} ${foreign.data?.code}）`);
    }
    step('R2 期數超出定價區範圍（本區 1–3 期）→ PURCHASE_PERIOD_INVALID');
    {
      const r = await enroll({ course_type: 2, students: kids(2), period_count: 4 });
      ok(r.status === 400 && r.data?.code === 'PURCHASE_PERIOD_INVALID', `4 期被擋（${r.status} ${r.data?.code}）`);
    }
    step('R3 組別停用 → COURSE_TYPE_INACTIVE；場館停用 → VENUE_INACTIVE；教練停用 → 擋');
    {
      await pg.query(`UPDATE course_type_configs SET is_active = FALSE WHERE pricing_zone_id = $1 AND course_type = 2`, [zoneId]);
      const ct = await enroll({ course_type: 2, students: kids(2) });
      await pg.query(`UPDATE course_type_configs SET is_active = TRUE WHERE pricing_zone_id = $1 AND course_type = 2`, [zoneId]);
      ok(ct.status === 400 && ct.data?.code === 'COURSE_TYPE_INACTIVE', `組別停用被擋（${ct.status} ${ct.data?.code}）`);
      await pg.query(`UPDATE venues SET is_active = FALSE WHERE id = $1`, [venueId]);
      const v = await enroll({ course_type: 2, students: kids(2) });
      await pg.query(`UPDATE venues SET is_active = TRUE WHERE id = $1`, [venueId]);
      ok(v.status === 400 && v.data?.code === 'VENUE_INACTIVE', `場館停用被擋（${v.status} ${v.data?.code}）`);
      await pg.query(`UPDATE coaches SET is_active = FALSE WHERE id = $1`, [coachId]);
      const c = await enroll({ course_type: 2, students: kids(2) });
      await pg.query(`UPDATE coaches SET is_active = TRUE WHERE id = $1`, [coachId]);
      ok(c.status === 400 && !(c.data?.enrollment_ids), `教練停用被擋（${c.status}）`);
    }

    // ───────────────────────── P 價格 ─────────────────────────
    step('P1 一般報名一對二 2 位 × 2 期，前端竄改金額為 1 元 → 後端以 6000 × 1.20 重算，每筆 7200、總額 28800');
    {
      const r = await enroll({ course_type: 2, students: kids(2), period_count: 2, original_price: 1, final_price: 1, total_amount: 1 });
      ok(r.status === 201 && (r.data?.enrollment_ids || []).length === 4, `成立 4 筆（${r.status}）`);
      const rows = await ordersOf(r.data.enrollment_ids);
      ok(rows.every((o) => o.original_price === 7200 && o.final_price === 7200), `每筆 7200（${rows.map((o) => o.final_price).join(',')}）`);
      ok(rows.every((o) => o.multiplier === 1.2 && o.total_sessions === 6), '購買係數快照 1.20、每期 6 堂（定價區設定）');
      ok(await checkoutTotal(r.data.checkout_id) === 28800, '付款單總額 28800');
    }
    step('P2 級距明價 {"1.20":7000} → 每筆 7000（不是 base × 係數）');
    {
      await pg.query(`UPDATE course_type_configs SET tier_prices = '{"1.20":7000}'::jsonb WHERE pricing_zone_id = $1 AND course_type = 2`, [zoneId]);
      const r = await enroll({ course_type: 2, students: kids(2) });
      const rows = await ordersOf(r.data?.enrollment_ids || []);
      ok(r.status === 201 && rows.length === 2 && rows.every((o) => o.final_price === 7000), `每筆 7000（${rows.map((o) => o.final_price).join(',')}）`);
    }
    step('P3 折價券 9 折（保留 0.9）：14000 折 1400，兩筆各 6300、總額 12600、用量記一筆');
    {
      promoId = (await pg.query(
        `INSERT INTO promotions (name, type, discount_value, coupon_code, applicable_course_types, applicable_venue_ids,
                                 start_date, end_date, status)
         VALUES ($1,'PERCENTAGE',0.9,$2,ARRAY[2],ARRAY[$3]::varchar[],NOW() - INTERVAL '1 day',NOW() + INTERVAL '1 day','active')
         RETURNING id`, [`稽核券${suffix}`, coupon, venueId])).rows[0].id;
      const r = await enroll({ course_type: 2, students: kids(2), promotion: { coupon_code: coupon } });
      ok(r.status === 201, `成立（${r.status} ${r.data?.code || ''}）`);
      const rows = await ordersOf(r.data.enrollment_ids);
      ok(rows.every((o) => o.original_price === 7000 && o.final_price === 6300), `每筆原價 7000、實付 6300（${rows.map((o) => o.final_price).join(',')}）`);
      ok(await checkoutTotal(r.data.checkout_id) === 12600, '付款單總額 12600');
      const usage = (await pg.query(`SELECT discount_amount::float8 AS d FROM promotion_usages WHERE promotion_id = $1`, [promoId])).rows;
      ok(usage.length === 1 && usage[0].d === 1400, `用量 1 筆、折 1400（${usage.map((u) => u.d).join(',')}）`);
    }
    step('P3b 折價券次數用盡、指定家長券給別人用 → 400 COUPON_*，整筆退回、不降級成原價');
    {
      await pg.query(`UPDATE promotions SET max_uses = 1 WHERE id = $1`, [promoId]);
      const ex = await enroll({ course_type: 2, students: kids(2), promotion: { coupon_code: coupon } });
      // 對外 code 只在 publicMessage 時透出細項，否則一律 COUPON_INVALID —— 這裡驗的是「後端擋下、不建單」。
      ok(ex.status === 400 && /^COUPON_/.test(ex.data?.code || '') && !ex.data?.enrollment_ids, `次數用盡被擋（${ex.status} ${ex.data?.code}）`);
      await pg.query(`UPDATE promotions SET max_uses = NULL, eligible_parent_id = $2 WHERE id = $1`, [promoId, outsider]);
      const owner = await enroll({ course_type: 2, students: kids(2), promotion: { coupon_code: coupon } });
      ok(owner.status === 400 && /^COUPON_/.test(owner.data?.code || '') && !owner.data?.enrollment_ids, `非指定家長被擋（${owner.status} ${owner.data?.code}）`);
      await pg.query(`UPDATE promotions SET status = 'archived' WHERE id = $1`, [promoId]);
    }
    step('P4 教練係數以 admin_staff 為準（1.50 蓋過 coaches 的 1.20）→ 一對二單價 6000 × 1.50 = 9000');
    {
      await pg.query(`UPDATE course_type_configs SET tier_prices = NULL WHERE pricing_zone_id = $1 AND course_type = 2`, [zoneId]);
      await pg.query(`INSERT INTO admin_staff (id, name, role, multiplier, is_coach) VALUES ($1,$2,'coach',1.50,TRUE)`,
        [ragicId, `稽核教練${suffix}`]);
      const r = await enroll({ course_type: 2, students: kids(2) });
      const rows = await ordersOf(r.data?.enrollment_ids || []);
      ok(r.status === 201 && rows.every((o) => o.final_price === 9000 && o.multiplier === 1.5),
        `每筆 9000、快照 1.50（${rows.map((o) => `${o.final_price}@${o.multiplier}`).join(',')}）`);
    }
    step('P5 試上：trial_price 700 × 係數 1.50 = 每人每堂 1050；2 位 × 2 堂 → 4 筆、總額 4200、現場付費、每筆 1 堂');
    {
      const r = await enroll({ course_type: 2, students: kids(2), period_count: 2, order_kind: 'trial', payment_method: 'bank_transfer', final_price: 1 });
      ok(r.status === 201 && (r.data?.enrollment_ids || []).length === 4, `成立 4 筆（${r.status} ${r.data?.code || ''}）`);
      const rows = await ordersOf(r.data.enrollment_ids);
      ok(rows.every((o) => o.final_price === 1050 && o.total_sessions === 1 && o.order_kind === 'trial' && o.payment_method === 'on_site'),
        `每筆 1050、1 堂、試上、現場付費（${rows.map((o) => `${o.final_price}/${o.total_sessions}/${o.payment_method}`).join(',')}）`);
      ok(await checkoutTotal(r.data.checkout_id) === 4200, '付款單總額 4200');
    }
    step('P6 試上不能用折價券；組別沒開試上 → 擋；一般報名不能選現場付費');
    {
      const c = await enroll({ course_type: 2, students: kids(2), order_kind: 'trial', promotion: { coupon_code: coupon } });
      ok(c.status === 400 && c.data?.code === 'TRIAL_COUPON_NOT_SUPPORTED', `試上帶券被擋（${c.status} ${c.data?.code}）`);
      await pg.query(`UPDATE course_type_configs SET trial_enabled = FALSE WHERE pricing_zone_id = $1 AND course_type = 3`, [zoneId]);
      const t = await enroll({ course_type: 3, students: kids(3), order_kind: 'trial' });
      ok(t.status === 400 && t.data?.code === 'TRIAL_NOT_ENABLED', `未開試上被擋（${t.status} ${t.data?.code}）`);
      const s = await enroll({ course_type: 2, students: kids(2), payment_method: 'on_site' });
      ok(s.status === 400 && s.data?.code === 'ON_SITE_TRIAL_ONLY', `一般報名現場付費被擋（${s.status} ${s.data?.code}）`);
    }

    // ───────────────────────── X 目前沒有規則的現況證據 ─────────────────────────
    step('X1 同一位學員再買一次試上 → 目前成立（無「試上次數上限」規則，列給 Owner 決定）');
    {
      const r = await enroll({ course_type: 2, students: kids(2), order_kind: 'trial' });
      ok(r.status === 201, `第二次試上仍成立（${r.status}）`);
    }
    step('X2 同一組學員同教練同組別再買一次 → 目前成立（無「重複報名」擋，列給 Owner 決定）');
    {
      const r = await enroll({ course_type: 2, students: kids(2) });
      ok(r.status === 201, `重複購買仍成立（${r.status}）`);
    }

    // ───────────────────────── H／G 團報人數與價格快照 ─────────────────────────
    let groupId = null;
    let joinToken = null;
    step('H5 團報：一對一不能發起；一對六一戶帶 7 位 → OVER_CAPACITY，不建團');
    {
      const one = await call(route.base, 'POST', '/api/group-orders', tokenA,
        { course_type: 1, venue_id: venueId, coach_id: coachId, student_ids: [kidsA[0]] });
      ok(one.status === 400 && one.data?.code === 'GROUP_NOT_ALLOWED_1V1', `一對一被擋（${one.status} ${one.data?.code}）`);
      const over = await call(route.base, 'POST', '/api/group-orders', tokenA,
        { course_type: 6, venue_id: venueId, coach_id: coachId, student_ids: kidsA.slice(0, 7) });
      ok(over.status === 400 && over.data?.code === 'OVER_CAPACITY', `7 位被擋（${over.status} ${over.data?.code}）`);
      const n = Number((await pg.query(`SELECT COUNT(*) FROM group_orders WHERE leader_parent_id = $1`, [parentA])).rows[0].count);
      ok(n === 0, '沒有建立任何團');
    }
    step('G1 一對六團主帶 4 位發起 → 人數存 6／6；單價快照 3000 × 1.50 = 4500；團主應付 4500 × 4 = 18000');
    {
      const r = await call(route.base, 'POST', '/api/group-orders', tokenA,
        { course_type: 6, venue_id: venueId, coach_id: coachId, student_ids: kidsA.slice(0, 4), original_price: 1 });
      ok(r.status === 201, `發起成功（${r.status} ${r.data?.code || ''}）`);
      groupId = r.data.id;
      joinToken = r.data.join_token;
      const go = (await pg.query(`SELECT min_students, max_students, purchased_unit_price::float8 AS unit FROM group_orders WHERE id = $1`, [groupId])).rows[0];
      ok(go.min_students === 6 && go.max_students === 6 && go.unit === 4500, `6／6、快照 4500（${go.min_students}/${go.max_students} ${go.unit}）`);
      const leader = (await pg.query(`SELECT final_amount::float8 AS amt FROM group_order_members WHERE group_order_id = $1 AND is_leader`, [groupId])).rows[0];
      ok(leader.amt === 18000, `團主 18000（${leader.amt}）`);
    }
    step('H6 第二戶帶 3 位加入（4+3>6）→ OVER_CAPACITY，成員數不變');
    {
      const r = await call(route.base, 'POST', `/api/group-orders/by-token/${joinToken}/join`, tokenB, { student_ids: kidsB.slice(0, 3) });
      ok(r.status === 409 && r.data?.code === 'OVER_CAPACITY', `被擋（${r.status} ${r.data?.code}）`);
      const n = Number((await pg.query(`SELECT COUNT(*) FROM group_order_members WHERE group_order_id = $1`, [groupId])).rows[0].count);
      ok(n === 1, '成員仍只有團主');
      const self = await call(route.base, 'POST', `/api/group-orders/by-token/${joinToken}/join`, tokenA, { student_ids: [kidsA[5]] });
      ok(self.status === 409 && self.data?.code === 'ALREADY_MEMBER', `團主不能再加入自己的團（${self.status} ${self.data?.code}）`);
    }
    step('G2 教練日後調價（admin_staff 1.50 → 2.00）→ 第二戶帶 2 位加入仍按快照 4500 × 2 = 9000');
    {
      await pg.query(`UPDATE admin_staff SET multiplier = 2.00 WHERE id = $1`, [ragicId]);
      const r = await call(route.base, 'POST', `/api/group-orders/by-token/${joinToken}/join`, tokenB, { student_ids: kidsB.slice(0, 2) });
      ok(r.status === 201, `加入成功（${r.status} ${r.data?.code || ''}）`);
      const m = (await pg.query(`SELECT final_amount::float8 AS amt FROM group_order_members WHERE group_order_id = $1 AND parent_id = $2`, [groupId, parentB])).rows[0];
      ok(m.amt === 9000, `第二戶 9000（${m.amt}）`);
    }
    step('H7 一對六 6 人到齊但付款資料不齊 → 送審資格 MISSING_PAYMENT_PROOF；舊團存 min 5、只有 5 人 → BELOW_MIN（需 6）');
    {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const order = (await c.query(`SELECT * FROM group_orders WHERE id = $1 FOR UPDATE`, [groupId])).rows[0];
        const full = await evaluateSubmitReadiness(c, order);
        ok(full.ok === false && full.code === 'MISSING_PAYMENT_PROOF' && full.total === 6, `6/6 但缺付款（${full.code} ${full.total}）`);
        await c.query(`UPDATE group_order_members SET payment_proof_url = 'https://example.com/p.jpg', transfer_last_5 = '12345' WHERE group_order_id = $1`, [groupId]);
        const paid = await evaluateSubmitReadiness(c, order);
        ok(paid.ok === true, '付款齊備後可送審');
        // 舊團形狀：min 5／max 6，拿掉一位 → 5 人
        await c.query(`UPDATE group_orders SET min_students = 5 WHERE id = $1`, [groupId]);
        await c.query(`UPDATE group_order_members SET student_names = student_names[1:1], student_ids = student_ids[1:1] WHERE group_order_id = $1 AND parent_id = $2`, [groupId, parentB]);
        const legacy = (await c.query(`SELECT * FROM group_orders WHERE id = $1`, [groupId])).rows[0];
        const five = await evaluateSubmitReadiness(c, legacy);
        ok(five.ok === false && five.code === 'BELOW_MIN' && five.required === 6 && five.total === 5, `5/6 → BELOW_MIN（${five.code} ${five.total}/${five.required}）`);
        await c.query('ROLLBACK');
      } finally { c.release(); }
    }

    // ───────────────────────── E 簽到守門（凍結區唯讀驗證）─────────────────────────
    step('E1 來源報名有效 → 可簽到（回名單）；來源已退費 → ENROLLMENT_ENTITLEMENT_INACTIVE；課期退費 → PERIOD_ENTITLEMENT_INACTIVE；找不到來源 → ENROLLMENT_SOURCE_UNRESOLVED');
    {
      const eid = `BRA${suffix}E1`.toUpperCase();
      await pg.query(
        `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
                                        original_price, final_price, status, submitted_at, student_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,9000,9000,'confirmed',NOW(),$8)`,
        [eid, `稽核家長A${suffix}`, phoneA, [`稽核A孩0${suffix}`], `稽核教練${suffix}`, coachId, venueId, [kidsA[0]]]);
      const mkPeriod = async (adminEnrollmentId) => {
        const id = (await pg.query(
          `INSERT INTO course_periods (coach_id, venue_id, course_type, total_sessions, expires_at, original_price, final_price, status, admin_enrollment_id)
           VALUES ($1,$2,1,6,CURRENT_DATE + 90,9000,9000,'active',$3) RETURNING id`, [coachId, venueId, adminEnrollmentId])).rows[0].id;
        periodIds.push(id);
        await pg.query(`INSERT INTO course_period_enrollments (course_period_id, student_id, status) VALUES ($1,$2,'active')`, [id, kidsA[0]]);
        return id;
      };
      const periodId = await mkPeriod(eid);
      const orphanId = await mkPeriod(null);
      const attempt = async (pid) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const roster = await assertCourseEntitlement(c, pid);
          return { roster };
        } catch (e) {
          return { code: e.code };
        } finally {
          await c.query('ROLLBACK').catch(() => {});
          c.release();
        }
      };
      const live = await attempt(periodId);
      ok(Array.isArray(live.roster) && live.roster.map(String).includes(String(kidsA[0])), '有效 → 名單含學員');
      await pg.query(`UPDATE admin_enrollments SET status = 'refunded' WHERE id = $1`, [eid]);
      const refunded = await attempt(periodId);
      ok(refunded.code === 'ENROLLMENT_ENTITLEMENT_INACTIVE', `來源已退費被擋（${refunded.code}）`);
      await pg.query(`UPDATE admin_enrollments SET status = 'confirmed' WHERE id = $1`, [eid]);
      await pg.query(`UPDATE course_periods SET status = 'refunded' WHERE id = $1`, [periodId]);
      const periodRefunded = await attempt(periodId);
      ok(periodRefunded.code === 'PERIOD_ENTITLEMENT_INACTIVE', `課期已退費被擋（${periodRefunded.code}）`);
      const orphan = await attempt(orphanId);
      ok(orphan.code === 'ENROLLMENT_SOURCE_UNRESOLVED', `找不到來源被擋（${orphan.code}）`);
    }

    step('E2 退費身分核對（lockRefundPeriods）：團報訂單缺家長識別 → REFUND_IDENTITY_REVIEW_REQUIRED；補齊後可鎖；同一家長本期兩筆有效 → 再擋');
    {
      const gid = randomUUID();
      await pg.query(
        `INSERT INTO group_orders (id, leader_parent_id, venue_id, course_type, coach_id, status, join_token, min_students, max_students, period_count)
         VALUES ($1,$2,$3,2,$4,'approved',$5,2,2,1)`, [gid, parentA, venueId, coachId, `bra-refund-${suffix}`]);
      const gEid = `BRA${suffix}G1`.toUpperCase();
      await pg.query(
        `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
                                        original_price, final_price, status, submitted_at, group_order_id, is_group_shared)
         VALUES ($1,$2,$3,$4,$5,$6,$7,2,6000,6000,'confirmed',NOW(),$8,TRUE)`,
        [gEid, `稽核家長A${suffix}`, phoneA, [`稽核A孩0${suffix}`], `稽核教練${suffix}`, coachId, venueId, gid]);
      const gPeriod = (await pg.query(
        `INSERT INTO course_periods (coach_id, venue_id, course_type, total_sessions, expires_at, original_price, final_price, status, group_order_id)
         VALUES ($1,$2,2,6,CURRENT_DATE + 90,12000,12000,'active',$3) RETURNING id`, [coachId, venueId, gid])).rows[0].id;
      periodIds.push(gPeriod);
      const tryLock = async (id) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          return { periods: await lockRefundPeriods(c, id) };
        } catch (e) {
          return { code: e.code };
        } finally {
          await c.query('ROLLBACK').catch(() => {});
          c.release();
        }
      };
      const noIdentity = await tryLock(gEid);
      ok(noIdentity.code === 'REFUND_IDENTITY_REVIEW_REQUIRED', `缺家長識別被擋（${noIdentity.code}）`);
      const checkoutId = (await pg.query(`INSERT INTO checkout_sessions (parent_id) VALUES ($1) RETURNING checkout_id`, [parentA])).rows[0].checkout_id;
      await pg.query(`UPDATE admin_enrollments SET checkout_id = $2 WHERE id = $1`, [gEid, checkoutId]);
      await pg.query(
        `INSERT INTO group_order_members (group_order_id, parent_id, student_names, student_ids, is_leader)
         VALUES ($1,$2,$3,$4,TRUE)`, [gid, parentA, [`稽核A孩0${suffix}`], [kidsA[0]]]);
      const okLock = await tryLock(gEid);
      ok(Array.isArray(okLock.periods) && okLock.periods.length === 1, `識別齊全可鎖定 1 個課期（${okLock.code || okLock.periods?.length}）`);
      await pg.query(
        `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
                                        original_price, final_price, status, submitted_at, group_order_id, is_group_shared, checkout_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,2,6000,6000,'confirmed',NOW(),$8,TRUE,$9)`,
        [`${gEid}B`, `稽核家長A${suffix}`, phoneA, [`稽核A孩1${suffix}`], `稽核教練${suffix}`, coachId, venueId, gid, checkoutId]);
      const twoRows = await tryLock(gEid);
      ok(twoRows.code === 'REFUND_IDENTITY_REVIEW_REQUIRED', `同一家長本期兩筆有效被擋（${twoRows.code}）`);
    }

    // ───────────────────────── T 評價門檻 ─────────────────────────
    step('T1 教練近 3 個月平均總評 2 分（門檻 avg_overall）→ 寫告警；同月再跑不重複');
    {
      const th = (await pg.query(`SELECT min_value::float8 AS v FROM eval_thresholds WHERE metric = 'avg_overall' AND is_active`)).rows[0];
      if (!th) {
        await pg.query(`INSERT INTO eval_thresholds (metric, min_value, window_months, is_active) VALUES ('avg_overall', 4, 3, TRUE)
                        ON CONFLICT (metric) DO UPDATE SET is_active = TRUE`);
      }
      for (const [pid, parent] of [[periodIds[0], parentA], [periodIds[1], parentB]]) {
        await pg.query(
          `INSERT INTO course_evaluations (course_period_id, parent_id, coach_id, score_teaching, score_attitude, score_progress, score_overall, renew_intent, submitted_at)
           VALUES ($1,$2,$3,2,2,2,2,'no',NOW())`, [pid, parent, coachId]);
      }
      await evaluations.detectBelowThreshold();
      const alerts = (await pg.query(`SELECT metric FROM eval_threshold_alerts WHERE coach_id = $1 ORDER BY metric`, [coachId])).rows.map((r) => r.metric);
      ok(alerts.includes('avg_overall'), `寫入 avg_overall 告警（${alerts.join(',')}）`);
      await evaluations.detectBelowThreshold();
      const again = Number((await pg.query(`SELECT COUNT(*) FROM eval_threshold_alerts WHERE coach_id = $1`, [coachId])).rows[0].count);
      ok(again === alerts.length, `同月不重複（${again}）`);
    }
    step('T2 評分超出 1–5 → 後端夾到範圍內；缺任一項 → 400；重複送出 → 409');
    {
      const evalId = (await pg.query(
        `INSERT INTO course_evaluations (course_period_id, parent_id, coach_id) VALUES ($1,$2,$3) RETURNING id`,
        [periodIds[0], outsider, coachId])).rows[0].id;
      let missing = null;
      try { await evaluations.submit(evalId, outsider, { score_teaching: 5, score_attitude: 5, score_progress: 5 }); } catch (e) { missing = e.status; }
      ok(missing === 400, `缺總評被擋（${missing}）`);
      const row = await evaluations.submit(evalId, outsider, { score_teaching: 9, score_attitude: 0, score_progress: 3, score_overall: 5 });
      ok(row.score_teaching === 5 && row.score_attitude === 1, `9→5、0→1（${row.score_teaching}/${row.score_attitude}）`);
      let dup = null;
      try { await evaluations.submit(evalId, outsider, { score_teaching: 1, score_attitude: 1, score_progress: 1, score_overall: 1 }); } catch (e) { dup = e.status; }
      ok(dup === 409, `重複送出被擋（${dup}）`);
    }

    console.log(`\nPASS business_rules_audit_db_test（${passed} 項斷言）`);
  } finally {
    const q = (sql, args) => pg.query(sql, args).catch((e) => console.warn('[cleanup]', e.message));
    await q(`DELETE FROM eval_threshold_alerts WHERE coach_id = $1`, [coachId]);
    await q(`DELETE FROM course_evaluations WHERE coach_id = $1`, [coachId]);
    if (periodIds.length) {
      await q(`DELETE FROM course_period_enrollments WHERE course_period_id = ANY($1::uuid[])`, [periodIds]);
      await q(`DELETE FROM course_periods WHERE id = ANY($1::uuid[])`, [periodIds]);
    }
    const groups = (await pg.query(`SELECT id FROM group_orders WHERE leader_parent_id = ANY($1::uuid[])`, [[parentA, parentB]])
      .catch(() => ({ rows: [] }))).rows.map((r) => r.id);
    if (groups.length) {
      await q(`DELETE FROM promotion_usages WHERE group_order_id = ANY($1::uuid[])`, [groups]);
      await q(`DELETE FROM group_order_audit_logs WHERE group_order_id = ANY($1::uuid[])`, [groups]);
      await q(`DELETE FROM group_order_members WHERE group_order_id = ANY($1::uuid[])`, [groups]);
      await q(`DELETE FROM group_orders WHERE id = ANY($1::uuid[])`, [groups]);
    }
    await q(`DELETE FROM group_order_drafts WHERE parent_id = ANY($1::uuid[])`, [[parentA, parentB]]);
    const orderIds = (await pg.query(`SELECT id FROM admin_enrollments WHERE parent_phone = ANY($1::text[])`, [[phoneA, phoneB]])
      .catch(() => ({ rows: [] }))).rows.map((r) => r.id);
    if (orderIds.length) {
      await q(`DELETE FROM promotion_usages WHERE admin_enrollment_id = ANY($1::text[])`, [orderIds]);
      await q(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [orderIds]);
      await q(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [orderIds]);
    }
    if (promoId) {
      await q(`DELETE FROM promotion_usages WHERE promotion_id = $1`, [promoId]);
      await q(`DELETE FROM promotions WHERE id = $1`, [promoId]);
    }
    await q(`DELETE FROM checkout_sessions WHERE parent_id = ANY($1::uuid[])`, [[parentA, parentB]]);
    await q(`DELETE FROM request_idempotency_ledger WHERE actor_id = ANY($1::text[])`, [[parentA, parentB]]);
    await q(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [[parentA, parentB, outsider]]);
    await q(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [[parentA, parentB, outsider]]);
    await q(`DELETE FROM admin_staff WHERE id = $1`, [ragicId]);
    await q(`DELETE FROM coaches WHERE id = $1`, [coachId]);
    if (zoneId) {
      await q(`DELETE FROM course_type_config_audit_logs WHERE pricing_zone_id = $1`, [zoneId]);
      await q(`DELETE FROM course_type_configs WHERE pricing_zone_id = $1`, [zoneId]);
    }
    await q(`DELETE FROM venues WHERE id = $1`, [venueId]);
    if (zoneId) await q(`DELETE FROM pricing_zones WHERE id = $1`, [zoneId]);
    await pg.end().catch(() => {});
    await route.close();
    await pool.end().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
