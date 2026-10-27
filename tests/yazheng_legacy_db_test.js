'use strict';
/**
 * 雅正轉：手動建檔＋待對帳比對（雅正轉_手動建檔與對帳 SPEC v1，YZM-03／04／05／06）對真的 PostgreSQL（拋棄式測試庫）。
 *
 * 只動「舊系統轉移」的待對帳：預覽比對、對帳通過寫連結、擋重複、兩個櫃台同時對同一包、取消後可再建；
 * 一般付款單的發票格式與照片規則不變；舊系統轉移不寄通知信；同步推送帶 legacy_seqs。
 * 對帳路由實際以 HTTP 呼叫（express＋真的 checkouts 路由）；登入、權限、寄信換成替身，只驗雅正轉邏輯。
 * v1.1（YZM-08）：開課期用真的 periodProvisioning（B 方案要在課期上補舊紀錄）；
 *   堂數帶入、一次 1 期、家長未綁 LINE 擋下、補 legacy_import 紀錄、家長端 /lessons 與 /mine 的標記。
 * 資料全部虛構（公開 repo），結束時刪掉本測試建立的列。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');
process.env.DATABASE_URL = url;

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const stub = (rel, exports) => {
  const p = require.resolve(path.join(SERVER, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
let adminId = null; // 測試開始時取一個真實的後台帳號，當建檔人（created_by 有外鍵）
stub('middlewares/adminAuth', {
  requireAdminAuth: (req, _res, next) => { req.adminUser = { sub: adminId, name: '測試櫃台', role: 'admin' }; next(); },
  getScopedVenueIds: () => null,
  isVenueInScope: () => true,
});
stub('middlewares/requireResource', { requireResource: () => (_req, _res, next) => next(), requireAnyResource: () => (_req, _res, next) => next() });
let parentCtx = null; // 家長端 API 的登入身分（替身）
stub('middlewares/parentAuth', {
  requireParent: (req, _res, next) => { req.parent = parentCtx; next(); },
  optionalParent: (req, _res, next) => { req.parent = parentCtx; next(); },
  requireLiffUser: (_req, _res, next) => next(),
  signParentToken: () => 'test', getSecret: () => 'test', demoTokenAllowed: () => false,
});
const mailCalls = [];
stub('services/reconcileNotify', {
  enqueueReconcileMailDetailed: async (_c, args) => { mailCalls.push(args.refId); return { outcome: 'no_email' }; },
  deliverOutbox: async () => ({ sent: 0, dryRun: 0, failed: 0 }),
});
stub('services/ragicWriteback', { scheduleWriteback: () => {} });

const express = require(path.join(SERVER, 'node_modules/express'));
const { pool } = require(path.join(SERVER, 'models/db'));
const { createCheckoutSession } = require(path.join(SERVER, 'services/checkouts'));
const yz = require(path.join(SERVER, 'services/yazhengLegacy'));
const { listOrders } = require(path.join(SERVER, 'services/yazhengSync'));
const router = require(path.join(SERVER, 'routes/admin/checkouts'));
const enrollRouter = require(path.join(SERVER, 'routes/admin/enrollments'));
const coursesRouter = require(path.join(SERVER, 'routes/courses'));

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

const T = `yzt${Date.now().toString(36)}`;
const manualIds = []; // 走真實建檔 API 建出的訂單（id 由系統產生，不帶測試前綴），結束時一併刪
let legacyEnrollment = null; // YZM-08 帶入堂數那筆訂單，家長端測試用
const COACH = '測試教練甲';
const SNAP = '2026-10-22T21:06:00+08:00';
const pkgs = [
  // seq,      invoice,       candidates,                    coach,              students,           remaining
  ['990101', 'ZZ00000101', [], COACH, ['甲同學'], 2],
  ['990102', 'ZZ00000102', [], COACH, ['乙同學'], 3],          // 同一學員一次買兩包
  ['990103', 'ZZ00000102', [], COACH, ['乙同學'], 4],
  ['990104', 'ZE12345678', [], COACH, ['丙同學'], 5],          // 假發票：不同學員同教練
  ['990105', 'ZE12345678', [], COACH, ['丁同學'], 1],
  ['990106', '0', [], '測試教練乙', ['戊同學'], 6],            // 打錯的發票、別的教練
  ['990107', null, ['ZZ00000107', 'ZZ00000108'], COACH, ['己同學'], 2], // 同日多筆待確認
  ['990108', null, [], COACH, ['庚同學'], 3],                  // 沒有發票：改打舊單號
  ['990109', 'ZZ00000109', [], COACH, ['辛同學'], 6],          // 給「兩個櫃台同時對」用
  ['990110', 'ZZ00000110', [], COACH, ['壬同學'], 6],          // 給「匯入工具已建」用
];

// 舊系統每一堂：第一堂的教練是新系統有的（測教練對應），其他是新系統沒有的（用課期教練）。
const usesFor = (seq, n) => Array.from({ length: n }, (_, k) => ({
  at: `2026-08-${String(10 + k).padStart(2, '0')}T1${k}:00:00+08:00`,
  coach: k === 0 ? coachB.name : '舊系統離職教練',
  seq,
}));
async function seed() {
  for (const [seq, inv, cands, coach, names, rem] of pkgs) {
    await pool.query(
      `INSERT INTO yz_legacy_packages (seq, invoice, invoice_candidates, coach, student_names, course_name, course_type,
         total_sessions, remaining_sessions, used_sessions, uses, purchase_date, snapshot_at)
       VALUES ($1, $2, $3::text[], $4, $5::text[], '家教1VS1', 1, 6, $6, $7, $8::jsonb, '2026-07-01', $9)`,
      [seq, inv, cands, coach, names, rem, 6 - rem,
        JSON.stringify(usesFor(seq, 6 - rem).map(({ at, coach: c }) => ({ at, coach: c }))), SNAP]);
  }
}

let venueId;
let coachA; // 課期教練（訂單的 coach_id）
let coachB; // 舊系統某一堂的教練，新系統有同名的人
let parentId; // 已綁 LINE 的測試家長（電話 BOUND_PHONE）
const BOUND_PHONE = '0912000999';
const UNBOUND_PHONE = '0912000998';
async function newCheckout({ paymentMethod = '舊系統轉移', coach = COACH, periods = 1, phone = BOUND_PHONE } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const co = await createCheckoutSession(client, { totalAmount: 0, by: 'test', paymentMethod: 'bank_transfer' });
    const ids = [];
    for (let i = 1; i <= periods; i += 1) {
      const id = `${T}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
      ids.push(id);
      await client.query(
        `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
           original_price, final_price, status, submitted_at, total_sessions, used_sessions, period_count, period_number,
           checkout_id, payment_method, order_kind)
         VALUES ($1, '測試家長', $8, ARRAY['測試學員'], $2, $9, $3, 1, 0, 0, 'pending_payment', NOW(), 6, 0, $4, $5, $6, $7, 'standard')`,
        [id, `${coach}(50%)`, venueId, periods, i, co.checkoutId, paymentMethod, phone, coachA.id]);
    }
    await client.query('COMMIT');
    return { checkoutId: co.checkoutId, ids };
  } finally { client.release(); }
}

console.log('yazheng_legacy_db_test');

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/checkouts', router);
  app.use('/api/admin/enrollments', enrollRouter);
  app.use('/api/courses', coursesRouter);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin/checkouts`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    venueId = (await pool.query('SELECT id FROM venues ORDER BY id LIMIT 1')).rows[0].id;
    adminId = (await pool.query('SELECT id FROM admin_users ORDER BY id LIMIT 1')).rows[0]?.id || null;
    // 名字在新系統唯一、不是佔位的教練兩位：A 當課期教練，B 當舊系統某一堂的教練
    [coachA, coachB] = (await pool.query(
      `SELECT c.id, c.name FROM coaches c
        WHERE NOT COALESCE(c.is_placeholder, FALSE) AND COALESCE(c.name, '') <> ''
          AND (SELECT count(*) FROM coaches c2 WHERE c2.name = c.name) = 1
        ORDER BY c.id LIMIT 2`)).rows;
    assert.ok(coachA && coachB, '測試庫需要至少兩位教練');
    parentId = (await pool.query(
      `INSERT INTO parents (phone, name, line_uid, is_active) VALUES ($1, '測試家長', $2, TRUE) RETURNING id`,
      [BOUND_PHONE, `TEST_${T}`])).rows[0].id;
    parentCtx = { id: parentId, phone: BOUND_PHONE, lineUid: `TEST_${T}` };
    await seed();
    const co = await newCheckout();
    const children = [{ coach: `${COACH}(50%)` }];

    await check('YZM-02 真的呼叫手動建檔 API：「舊系統轉移」原樣存下、進待對帳、預覽比對可用', async () => {
      assert.ok(adminId, '測試庫需要至少一個後台帳號');
      const enrollBase = base.replace('/checkouts', '/enrollments');
      const r = await fetch(enrollBase, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: `admin-enrollment:${T}-manual`, parent_name: '測試家長', parent_phone: '0912000998',
          students: ['測試學員'], venue_id: venueId, coach: COACH, course_type: 1, total_sessions: 6,
          original_price: 0, final_price: 0, payment_method: '舊系統轉移', transfer_last_5: '',
        }),
      });
      const body = await r.json();
      assert.ok(r.status === 200 || r.status === 201, `建檔失敗：${r.status} ${JSON.stringify(body)}`);
      const ids = body.enrollment_ids || [body.id];
      const rows = (await pool.query(`SELECT id, status, payment_method, checkout_id FROM admin_enrollments WHERE id = ANY($1)`, [ids])).rows;
      assert.ok(rows.length >= 1);
      for (const row of rows) assert.deepEqual([row.status, row.payment_method], ['pending_payment', '舊系統轉移']);
      const list = await get('/?status=pending');
      const listed = (Array.isArray(list.body) ? list.body : list.body.items || list.body.rows || [])
        .some((c) => c.checkout_id === rows[0].checkout_id);
      assert.ok(listed, '待對帳清單應該看得到這張付款單');
      const m = await get(`/${rows[0].checkout_id}/legacy-match?invoice=ZZ00000101`);
      assert.deepEqual([m.status, m.body.status], [200, 'MATCH']);
      manualIds.push(...ids);
    });

    await check('YZM-05 對到 1 包 → MATCH', async () => {
      const m = await yz.matchLegacy(pool, children, { invoice: ' zz00000101 ' });
      assert.equal(m.status, 'MATCH');
      assert.deepEqual(m.selectable, ['990101']);
      assert.equal(m.ok, true);
    });
    await check('YZM-05 同一學員一次買兩包 → MATCH 整組、剩餘加總', async () => {
      const m = await yz.matchLegacy(pool, children, { invoice: 'ZZ00000102' });
      assert.equal(m.status, 'MATCH');
      assert.deepEqual(m.selectable, ['990102', '990103']);
      assert.equal(m.remaining_total, 7);
    });
    await check('YZM-05 假發票、同教練不同學員 → CHOOSE（兩個選項）', async () => {
      const m = await yz.matchLegacy(pool, children, { invoice: 'ZE12345678' });
      assert.equal(m.status, 'CHOOSE');
      assert.equal(m.options.length, 2);
      assert.equal(m.ok, false);
    });
    await check('YZM-05 發票在快照但教練不同 → COACH_MISMATCH；找不到 → INVOICE_NOT_FOUND', async () => {
      assert.equal((await yz.matchLegacy(pool, children, { invoice: '0' })).reason, 'COACH_MISMATCH');
      assert.equal((await yz.matchLegacy(pool, children, { invoice: 'ZZ99999999' })).reason, 'INVOICE_NOT_FOUND');
    });
    await check('YZM-05 同日多筆待確認：候選發票對得到', async () => {
      const m = await yz.matchLegacy(pool, children, { invoice: 'ZZ00000108' });
      assert.deepEqual([m.status, m.selectable], ['MATCH', ['990107']]);
    });
    await check('YZM-05 改打舊單號：存在的可轉、不存在的列為 missing', async () => {
      const m = await yz.matchLegacy(pool, children, { seqs: '990108, 999999' });
      assert.deepEqual([m.status, m.missing, m.selectable, m.ok], ['SEQS', ['999999'], ['990108'], false]);
      assert.equal((await yz.matchLegacy(pool, children, { seqs: '990108' })).ok, true);
    });

    await check('YZM-05 預覽 API：舊系統轉移付款單回比對結果；一般付款單回 400', async () => {
      const r = await get(`/${co.checkoutId}/legacy-match?invoice=ZZ00000102`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.selectable, ['990102', '990103']);
      const normal = await newCheckout({ paymentMethod: '轉帳' });
      const r2 = await get(`/${normal.checkoutId}/legacy-match?invoice=ZZ00000102`);
      assert.deepEqual([r2.status, r2.body.code], [400, 'NOT_LEGACY_CHECKOUT']);
    });

    await check('YZM-04 一般付款單：發票格式與照片規則不變', async () => {
      const normal = await newCheckout({ paymentMethod: '轉帳' });
      const bad = await post(`/${normal.checkoutId}/reconcile`, { invoice_number: '0', invoice_image_url: 'https://x.invalid/a.png' });
      assert.equal(bad.status, 400);
      const noImg = await post(`/${normal.checkoutId}/reconcile`, { invoice_number: 'AB12345678' });
      assert.equal(noImg.status, 400);
    });

    await check('YZM-04/05 CHOOSE 沒點選不能對帳；點選後通過、不寄信、記連結與備註', async () => {
      const c = await newCheckout();
      const none = await post(`/${c.checkoutId}/reconcile`, { invoice_number: 'ZE12345678' });
      assert.deepEqual([none.status, none.body.code], [400, 'LEGACY_SELECTION_REQUIRED']);
      const before = mailCalls.length;
      const ok = await post(`/${c.checkoutId}/reconcile`, { invoice_number: 'ZE12345678', legacy: { mode: 'invoice', seqs: ['990104'] } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(ok.body.legacy.seqs, ['990104']);
      assert.equal(mailCalls.length, before, '舊系統轉移不寄通知信');
      const links = (await pool.query(`SELECT seq, enrollment_id FROM yz_legacy_links WHERE seq = '990104' ORDER BY enrollment_id`)).rows;
      assert.equal(links.length, 1);
      const rows = (await pool.query(`SELECT status, invoice_number, invoice_image_url, notes FROM admin_enrollments WHERE id = ANY($1)`, [c.ids])).rows;
      for (const row of rows) {
        assert.equal(row.status, 'confirmed');
        assert.equal(row.invoice_number, 'ZE12345678');
        assert.equal(row.invoice_image_url, null);
        assert.ok(row.notes.startsWith('雅正轉｜舊單 990104｜舊發票 ZE12345678'), row.notes);
      }
    });

    await check('YZM-03 已經建過的擋下；同發票另一位學員仍可轉', async () => {
      const m = await yz.matchLegacy(pool, children, { invoice: 'ZE12345678' });
      assert.deepEqual([m.status, m.selectable], ['MATCH', ['990105']]);
      const c = await newCheckout();
      const dup = await post(`/${c.checkoutId}/reconcile`, { invoice_number: 'ZE12345678', legacy: { mode: 'invoice', seqs: ['990104'] } });
      assert.deepEqual([dup.status, dup.body.code], [400, 'LEGACY_SELECTION_INVALID']);
    });

    await check('YZM-04 改打舊單號：沒有發票也能對帳；打到已建過的會擋', async () => {
      const c = await newCheckout();
      const ok = await post(`/${c.checkoutId}/reconcile`, { legacy: { mode: 'seqs', seqs: '990108' } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const c2 = await newCheckout();
      const dup = await post(`/${c2.checkoutId}/reconcile`, { legacy: { mode: 'seqs', seqs: '990108' } });
      assert.deepEqual([dup.status, dup.body.code], [400, 'LEGACY_ALREADY_BUILT']);
    });

    await check('YZM-03 訂單取消後，這包可以再轉', async () => {
      const link = (await pool.query(`SELECT enrollment_id FROM yz_legacy_links WHERE seq = '990108'`)).rows;
      await pool.query(`UPDATE admin_enrollments SET status = 'cancelled' WHERE id = ANY($1)`, [link.map((l) => l.enrollment_id)]);
      assert.equal((await yz.matchLegacy(pool, children, { seqs: '990108' })).ok, true);
    });

    await check('YZM-03 匯入工具建的 ABLEPOS 訂單也算已建過', async () => {
      await pool.query(
        `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, venue_id, course_type, original_price,
           final_price, status, submitted_at, total_sessions, used_sessions, external_order_no)
         VALUES ($1, '測試家長', '0912000999', ARRAY['測試學員'], $2, $3, 1, 0, 0, 'confirmed', NOW(), 6, 0, 'ABLEPOS:990110')`,
        [`${T}IMP`.toUpperCase(), COACH, venueId]);
      assert.equal((await yz.matchLegacy(pool, children, { invoice: 'ZZ00000110' })).status, 'ALL_BUILT');
    });

    await check('YZM-05 兩個櫃台同時對同一包：只有一個成功', async () => {
      const a = await newCheckout();
      const b = await newCheckout();
      const [ra, rb] = await Promise.all([
        post(`/${a.checkoutId}/reconcile`, { invoice_number: 'ZZ00000109' }),
        post(`/${b.checkoutId}/reconcile`, { invoice_number: 'ZZ00000109' }),
      ]);
      const statuses = [ra.status, rb.status].sort();
      assert.deepEqual(statuses, [200, 400], JSON.stringify([ra.body, rb.body]));
      const n = Number((await pool.query(`SELECT count(DISTINCT l.enrollment_id) n FROM yz_legacy_links l WHERE seq = '990109'`)).rows[0].n);
      assert.equal(n, 1);
    });

    await check('YZM-05 鎖：第一個交易比對後鎖住舊單號，第二個要等它提交，之後看到「已經建過」', async () => {
      await pool.query(
        `INSERT INTO yz_legacy_packages (seq, invoice, coach, student_names, remaining_sessions, snapshot_at)
         VALUES ('990111', 'ZZ00000111', $1, ARRAY['癸同學'], 2, $2)`, [COACH, SNAP]);
      const a = await newCheckout();
      const t1 = await pool.connect();
      const t2 = await pool.connect();
      try {
        await t1.query('BEGIN');
        await t2.query('BEGIN');
        const r1 = await yz.resolveForReconcile(t1, children, { invoice: 'ZZ00000111' });
        assert.deepEqual(r1.seqs, ['990111']);
        let r2 = null;
        const p2 = yz.resolveForReconcile(t2, children, { invoice: 'ZZ00000111' }).then((r) => { r2 = r; });
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(r2, null, '第二個交易應該被鎖住、還在等');
        await yz.linkForReconcile(t1, { seqs: r1.seqs, children: [{ id: a.ids[0] }], checkoutId: a.checkoutId, invoice: 'ZZ00000111', by: 't1' });
        await t1.query('COMMIT');
        await p2;
        assert.equal(r2.code, 'LEGACY_ALREADY_BUILT');
      } finally {
        await t1.query('ROLLBACK').catch(() => {});
        await t2.query('ROLLBACK').catch(() => {});
        t1.release();
        t2.release();
      }
    });

    await check('YZM-08 預覽：回傳舊系統已用堂數；建 2 期、家長未綁 LINE 都列為會被擋的原因', async () => {
      const ok = await get(`/${(await newCheckout()).checkoutId}/legacy-match?invoice=ZZ00000102`);
      assert.deepEqual(ok.body.blockers, []);
      assert.deepEqual(ok.body.packages.map((p) => [p.seq, p.total_sessions, p.used_sessions, p.remaining_sessions]),
        [['990102', 6, 3, 3], ['990103', 6, 2, 4]]);
      const two = await get(`/${(await newCheckout({ periods: 2 })).checkoutId}/legacy-match?invoice=ZZ00000102`);
      assert.deepEqual(two.body.blockers.map((b) => b.code), ['LEGACY_ONE_PERIOD']);
      const unbound = await get(`/${(await newCheckout({ phone: UNBOUND_PHONE })).checkoutId}/legacy-match?invoice=ZZ00000102`);
      assert.deepEqual(unbound.body.blockers.map((b) => b.code), ['LEGACY_PARENT_NOT_BOUND']);
    });

    await check('YZM-08 對帳：建 2 期擋下（LEGACY_ONE_PERIOD），什麼都沒寫', async () => {
      const c = await newCheckout({ periods: 2 });
      const r = await post(`/${c.checkoutId}/reconcile`, { invoice_number: 'ZZ00000102' });
      assert.deepEqual([r.status, r.body.code], [409, 'LEGACY_ONE_PERIOD']);
      const rows = (await pool.query(`SELECT status FROM admin_enrollments WHERE id = ANY($1)`, [c.ids])).rows;
      assert.ok(rows.every((x) => x.status === 'pending_payment'));
      assert.equal((await pool.query(`SELECT 1 FROM yz_legacy_links WHERE enrollment_id = ANY($1)`, [c.ids])).rowCount, 0);
    });

    await check('YZM-08 對帳：家長未綁 LINE 擋下（LEGACY_PARENT_NOT_BOUND），沒開課期、沒連結', async () => {
      const c = await newCheckout({ phone: UNBOUND_PHONE });
      const r = await post(`/${c.checkoutId}/reconcile`, { invoice_number: 'ZZ00000102' });
      assert.deepEqual([r.status, r.body.code], [409, 'LEGACY_PARENT_NOT_BOUND']);
      assert.equal((await pool.query(`SELECT status FROM admin_enrollments WHERE id = $1`, [c.ids[0]])).rows[0].status, 'pending_payment');
      assert.equal((await pool.query(`SELECT 1 FROM course_periods WHERE admin_enrollment_id = $1`, [c.ids[0]])).rowCount, 0);
      assert.equal((await pool.query(`SELECT 1 FROM yz_legacy_links WHERE enrollment_id = $1`, [c.ids[0]])).rowCount, 0);
    });

    await check('YZM-08 對帳：同學員兩包 → 總堂數＝已用＋剩餘、補舊上課紀錄（legacy_import）、已用由紀錄重算', async () => {
      const c = await newCheckout();
      const r = await post(`/${c.checkoutId}/reconcile`, { invoice_number: 'ZZ00000102' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.legacy.total, r.body.legacy.used, r.body.legacy.remaining, r.body.legacy.sessions], [12, 5, 7, 5]);
      const ae = (await pool.query(`SELECT status, total_sessions, used_sessions FROM admin_enrollments WHERE id = $1`, [c.ids[0]])).rows[0];
      assert.deepEqual([ae.status, ae.total_sessions, ae.used_sessions], ['confirmed', 12, 5], '建檔填的 6 堂要被取代成 12');
      const cp = (await pool.query(`SELECT id, coach_id, total_sessions, used_sessions FROM course_periods WHERE admin_enrollment_id = $1`, [c.ids[0]])).rows[0];
      assert.deepEqual([cp.total_sessions, cp.used_sessions], [12, 5]);
      const sess = (await pool.query(
        `SELECT cs.scheduled_at, cs.status::text AS status, cs.session_deducted, cs.coach_id,
                array_agg(cr.checked_in_source || ':' || cr.attendance_status) AS checkins
           FROM course_sessions cs JOIN checkin_records cr ON cr.course_session_id = cs.id
          WHERE cs.course_period_id = $1 GROUP BY cs.id ORDER BY cs.scheduled_at`, [cp.id])).rows;
      const want = [...usesFor('990102', 3), ...usesFor('990103', 2)]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq.localeCompare(b.seq));
      assert.deepEqual(sess.map((s) => new Date(s.scheduled_at).toISOString()), want.map((u) => new Date(u.at).toISOString()));
      assert.ok(sess.every((s) => s.status === 'completed' && s.session_deducted === true));
      const created = (await pool.query(`SELECT bool_and(created_at = scheduled_at) AS ok FROM course_sessions WHERE course_period_id = $1`, [cp.id])).rows[0];
      assert.equal(created.ok, true, '建立時間比照匯入工具，記那一堂的時間');
      assert.ok(sess.every((s) => s.checkins.length === 1 && s.checkins[0] === 'legacy_import:ATTENDED'), JSON.stringify(sess.map((s) => s.checkins)));
      assert.deepEqual(sess.map((s) => s.coach_id), want.map((u) => (u.coach === coachB.name ? coachB.id : coachA.id)),
        '新系統有同名教練就用他，沒有就用課期教練');
      const audit = (await pool.query(`SELECT action FROM admin_enrollment_audit_logs WHERE enrollment_id = $1 AND action LIKE '雅正轉帶入%'`, [c.ids[0]])).rows;
      assert.equal(audit.length, 1);
      assert.ok(audit[0].action.includes('共 12 堂（舊系統已用 5、剩 7）'), audit[0].action);
      legacyEnrollment = c.ids[0];
    });

    await check('YZM-08 家長端：課程卡標舊系統轉移；上課紀錄回傳來源 legacy_import', async () => {
      const lessonsRes = await fetch(base.replace('/admin/checkouts', '/courses/lessons'));
      const lessons = await lessonsRes.json();
      assert.equal(lessonsRes.status, 200, JSON.stringify(lessons));
      const periodId = (await pool.query(`SELECT id FROM course_periods WHERE admin_enrollment_id = $1`, [legacyEnrollment])).rows[0].id;
      const mine = lessons.filter((l) => l.period_id === periodId);
      assert.equal(mine.length, 5, '舊系統上過的 5 堂都在上課紀錄');
      assert.ok(mine.every((l) => l.checkin_source === 'legacy_import' && l.checked_in_at), JSON.stringify(mine.map((l) => l.checkin_source)));
      const mineRes = await fetch(base.replace('/admin/checkouts', '/courses/mine'));
      const courses = await mineRes.json();
      assert.equal(mineRes.status, 200, JSON.stringify(courses));
      const list = Array.isArray(courses) ? courses : (courses.items || courses.rows || courses.courses || []);
      const card = list.find((x) => x.id === legacyEnrollment);
      assert.ok(card, '課程卡要找得到這筆');
      assert.equal(card.is_legacy_import, true);
      assert.deepEqual([card.total_sessions, card.used_sessions, card.remaining_sessions], [12, 5, 7],
        '課程卡：總＝舊包已用＋剩餘，已用＝舊系統紀錄，剩餘＝快照剩餘');
    });

    await check('YZM-08 對帳：剩 0 堂擋下（LEGACY_NOTHING_LEFT）；快照缺上課紀錄擋下（LEGACY_SNAPSHOT_INCOMPLETE）', async () => {
      await pool.query(
        `INSERT INTO yz_legacy_packages (seq, invoice, coach, student_names, total_sessions, remaining_sessions, used_sessions, uses, snapshot_at)
         VALUES ('990112', 'ZZ00000112', $1, ARRAY['子同學'], 1, 0, 1, $2::jsonb, $3),
                ('990113', 'ZZ00000113', $1, ARRAY['丑同學'], 6, 4, 2, '[]'::jsonb, $3)`,
        [COACH, JSON.stringify([{ at: '2026-08-01T10:00:00+08:00', coach: null }]), SNAP]);
      const none = await post(`/${(await newCheckout()).checkoutId}/reconcile`, { invoice_number: 'ZZ00000112' });
      assert.deepEqual([none.status, none.body.code], [409, 'LEGACY_NOTHING_LEFT']);
      const c = await newCheckout();
      const bad = await post(`/${c.checkoutId}/reconcile`, { invoice_number: 'ZZ00000113' });
      assert.deepEqual([bad.status, bad.body.code], [409, 'LEGACY_SNAPSHOT_INCOMPLETE']);
      assert.equal((await pool.query(`SELECT 1 FROM yz_legacy_links WHERE enrollment_id = $1`, [c.ids[0]])).rowCount, 0);
    });

    await check('YZM-06 同步推送：legacy_seqs 帶出涵蓋的舊單號，yazheng_tag 為 true', async () => {
      const { orders } = await listOrders({ since: new Date(Date.now() - 3600e3).toISOString(), limit: 1000 });
      const mine = orders.filter((o) => o.legacy_seqs.includes('990104'));
      assert.equal(mine.length, 1);
      assert.ok(mine.every((o) => o.yazheng_tag));
      const imp = orders.find((o) => o.legacy_seq === '990110');
      assert.deepEqual(imp.legacy_seqs, ['990110']);
    });
  } finally {
    await new Promise((r) => srv.close(r));
    const like = `${T.toUpperCase()}%`;
    if (manualIds.length) {
      const mc = (await pool.query(`SELECT DISTINCT checkout_id FROM admin_enrollments WHERE id = ANY($1)`, [manualIds])).rows.map((r) => r.checkout_id);
      await pool.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1)`, [manualIds]).catch(() => {});
      await pool.query(`DELETE FROM admin_enrollments WHERE id = ANY($1)`, [manualIds]).catch(() => {});
      await pool.query(`DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::uuid[])`, [mc]).catch(() => {});
      await pool.query(`DELETE FROM request_idempotency_ledger WHERE normalized_request_id LIKE $1`, [`%${T}%`]).catch(() => {});
    }
    await pool.query(`DELETE FROM yz_legacy_links WHERE seq LIKE '9901%'`).catch(() => {});
    const periods = (await pool.query(`SELECT id FROM course_periods WHERE admin_enrollment_id LIKE $1`, [like])).rows.map((r) => r.id);
    await pool.query(`DELETE FROM checkin_records WHERE course_session_id IN (SELECT id FROM course_sessions WHERE course_period_id = ANY($1::uuid[]))`, [periods]).catch(() => {});
    await pool.query(`DELETE FROM course_sessions WHERE course_period_id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pool.query(`DELETE FROM course_period_enrollments WHERE course_period_id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pool.query(`DELETE FROM course_periods WHERE id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pool.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id LIKE $1`, [like]).catch(() => {});
    const cos = (await pool.query(`SELECT DISTINCT checkout_id FROM admin_enrollments WHERE id LIKE $1`, [like])).rows.map((r) => r.checkout_id).filter(Boolean);
    await pool.query(`DELETE FROM checkout_invoices WHERE checkout_id = ANY($1::uuid[])`, [cos]).catch(() => {});
    await pool.query(`DELETE FROM admin_enrollments WHERE id LIKE $1`, [like]).catch(() => {});
    await pool.query(`DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::uuid[])`, [cos]).catch(() => {});
    await pool.query(`DELETE FROM yz_legacy_packages WHERE seq LIKE '9901%'`).catch(() => {});
    if (parentId) {
      await pool.query(`DELETE FROM student_audit_logs WHERE student_id IN (SELECT id FROM students WHERE parent_id = $1)`, [parentId]).catch(() => {});
      await pool.query(`DELETE FROM students WHERE parent_id = $1`, [parentId]).catch(() => {});
      await pool.query(`DELETE FROM parents WHERE id = $1`, [parentId]).catch(() => {});
    }
    await pool.end();
  }
  if (failures) { console.error(`yazheng_legacy_db_test: ${failures} 項失敗`); process.exit(1); }
  console.log('yazheng_legacy_db_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
