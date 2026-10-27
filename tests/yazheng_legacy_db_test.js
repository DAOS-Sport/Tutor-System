'use strict';
/**
 * 雅正轉：手動建檔＋待對帳比對（雅正轉_手動建檔與對帳 SPEC v1，YZM-03／04／05／06）對真的 PostgreSQL（拋棄式測試庫）。
 *
 * 只動「舊系統轉移」的待對帳：預覽比對、對帳通過寫連結、擋重複、兩個櫃台同時對同一包、取消後可再建；
 * 一般付款單的發票格式與照片規則不變；舊系統轉移不寄通知信；同步推送帶 legacy_seqs。
 * 對帳路由實際以 HTTP 呼叫（express＋真的 checkouts 路由）；登入、權限、開課期、寄信換成替身，只驗雅正轉邏輯。
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
stub('middlewares/adminAuth', {
  requireAdminAuth: (req, _res, next) => { req.adminUser = { sub: null, name: '測試櫃台', role: 'admin' }; next(); },
  getScopedVenueIds: () => null,
  isVenueInScope: () => true,
});
stub('middlewares/requireResource', { requireResource: () => (_req, _res, next) => next(), requireAnyResource: () => (_req, _res, next) => next() });
stub('services/periodProvisioning', { getSettings: async () => ({}), ensureGroupCoursePeriod: async () => [], ensureSoloCoursePeriod: async () => [] });
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

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

const T = `yzt${Date.now().toString(36)}`;
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

async function seed() {
  for (const [seq, inv, cands, coach, names, rem] of pkgs) {
    await pool.query(
      `INSERT INTO yz_legacy_packages (seq, invoice, invoice_candidates, coach, student_names, course_name, course_type,
         total_sessions, remaining_sessions, purchase_date, snapshot_at)
       VALUES ($1, $2, $3::text[], $4, $5::text[], '家教1VS1', 1, 6, $6, '2026-07-01', $7)`,
      [seq, inv, cands, coach, names, rem, SNAP]);
  }
}

let venueId;
async function newCheckout({ paymentMethod = '舊系統轉移', coach = COACH, periods = 1 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const co = await createCheckoutSession(client, { totalAmount: 0, by: 'test', paymentMethod: 'bank_transfer' });
    const ids = [];
    for (let i = 1; i <= periods; i += 1) {
      const id = `${T}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
      ids.push(id);
      await client.query(
        `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, venue_id, course_type,
           original_price, final_price, status, submitted_at, total_sessions, used_sessions, period_count, period_number,
           checkout_id, payment_method, order_kind)
         VALUES ($1, '測試家長', '0912000999', ARRAY['測試學員'], $2, $3, 1, 0, 0, 'pending_payment', NOW(), 6, 0, $4, $5, $6, $7, 'standard')`,
        [id, `${coach}(50%)`, venueId, periods, i, co.checkoutId, paymentMethod]);
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
    await seed();
    const co = await newCheckout();
    const children = [{ coach: `${COACH}(50%)` }];

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
      const c = await newCheckout({ periods: 2 });
      const none = await post(`/${c.checkoutId}/reconcile`, { invoice_number: 'ZE12345678' });
      assert.deepEqual([none.status, none.body.code], [400, 'LEGACY_SELECTION_REQUIRED']);
      const before = mailCalls.length;
      const ok = await post(`/${c.checkoutId}/reconcile`, { invoice_number: 'ZE12345678', legacy: { mode: 'invoice', seqs: ['990104'] } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(ok.body.legacy, { seqs: ['990104'] });
      assert.equal(mailCalls.length, before, '舊系統轉移不寄通知信');
      const links = (await pool.query(`SELECT seq, enrollment_id FROM yz_legacy_links WHERE seq = '990104' ORDER BY enrollment_id`)).rows;
      assert.equal(links.length, 2, '兩期兩筆訂單都要連結');
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

    await check('YZM-06 同步推送：legacy_seqs 帶出涵蓋的舊單號，yazheng_tag 為 true', async () => {
      const { orders } = await listOrders({ since: new Date(Date.now() - 3600e3).toISOString(), limit: 1000 });
      const mine = orders.filter((o) => o.legacy_seqs.includes('990104'));
      assert.equal(mine.length, 2);
      assert.ok(mine.every((o) => o.yazheng_tag));
      const imp = orders.find((o) => o.legacy_seq === '990110');
      assert.deepEqual(imp.legacy_seqs, ['990110']);
    });
  } finally {
    await new Promise((r) => srv.close(r));
    const like = `${T.toUpperCase()}%`;
    await pool.query(`DELETE FROM yz_legacy_links WHERE seq LIKE '9901%'`).catch(() => {});
    await pool.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id LIKE $1`, [like]).catch(() => {});
    const cos = (await pool.query(`SELECT DISTINCT checkout_id FROM admin_enrollments WHERE id LIKE $1`, [like])).rows.map((r) => r.checkout_id).filter(Boolean);
    await pool.query(`DELETE FROM checkout_invoices WHERE checkout_id = ANY($1::uuid[])`, [cos]).catch(() => {});
    await pool.query(`DELETE FROM admin_enrollments WHERE id LIKE $1`, [like]).catch(() => {});
    await pool.query(`DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::uuid[])`, [cos]).catch(() => {});
    await pool.query(`DELETE FROM yz_legacy_packages WHERE seq LIKE '9901%'`).catch(() => {});
    await pool.end();
  }
  if (failures) { console.error(`yazheng_legacy_db_test: ${failures} 項失敗`); process.exit(1); }
  console.log('yazheng_legacy_db_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
