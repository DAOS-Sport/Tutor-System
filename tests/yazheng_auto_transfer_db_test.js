'use strict';
/**
 * 雅正轉：對上的舊課自動轉入（雅正轉 SPEC YZM-09）對真的 PostgreSQL（拋棄式測試庫）。
 *
 * 驗：條件全符合才轉、建單形狀同 10/22 匯入工具、試跑不留資料、各種跳過原因、一次上限、重跑不重複、
 * 轉入後算「已建過」（櫃台改打舊單號會被擋）、同步清單帶出舊單號。
 * 資料全部虛構（公開 repo），結束時刪掉本測試建立的列。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');
process.env.DATABASE_URL = url;

const SERVER = path.join(__dirname, '..', 'server');
const { pool } = require(path.join(SERVER, 'models/db'));
const auto = require(path.join(SERVER, 'services/yazhengAutoTransfer'));
const yz = require(path.join(SERVER, 'services/yazhengLegacy'));
const { listOrders } = require(path.join(SERVER, 'services/yazhengSync'));

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

const T = `yzat${Date.now().toString(36)}`;
const COACH_A = `測試自動教練${T}`;
const COACH_B = `測試舊堂教練${T}`;
const COACH_DUP = `測試同名教練${T}`;
const PHONE = { p1: '0900123001', p2: '0900123002', p3: '0900123003', p5: '0900123005' };
const SNAP = '2026-10-22T21:06:00+08:00';
const coachIds = [];
const parentIds = [];
let venueId;
let coachA;
let coachB;
const fixtureOrders = [];

async function addCoach(name) {
  const id = (await pool.query(
    `INSERT INTO coaches (ragic_employee_id, name, phone, is_active) VALUES ($1, $2, $3, TRUE) RETURNING id::text`,
    [`${T}-${coachIds.length}`, name, `0900${String(Date.now() % 1e5).padStart(5, '0')}${coachIds.length}`])).rows[0].id;
  coachIds.push(id);
  return id;
}
async function addParent(phone, bound, kids) {
  const id = (await pool.query(
    `INSERT INTO parents (phone, name, line_uid, is_active) VALUES ($1, '測試家長', $2, TRUE) RETURNING id`,
    [phone, bound ? `TEST_${T}_${phone}` : null])).rows[0].id;
  parentIds.push(id);
  for (const k of kids) await pool.query(`INSERT INTO students (parent_id, name, is_active) VALUES ($1, $2, TRUE)`, [id, k]);
  return id;
}
// [seq, phone, coach, course_name, course_type, names, used, remaining, light, expired]
const PKGS = [
  ['990201', PHONE.p1, () => COACH_A, '家教1VS2 (20%)', 2, ['甲生', '乙 生'], 2, 4, '黃', 0], // 全符合 → 轉
  ['990202', PHONE.p1, () => COACH_A, '家教1VS3', 3, ['甲生'], 0, 6, '黃', 0],               // 1 對 3 只列 1 位
  ['990203', PHONE.p1, () => COACH_A, '家教1VS1', 1, ['丙生'], 1, 5, '綠', 0],               // 學員不在名下
  ['990204', PHONE.p2, () => COACH_A, '家教1VS1', 1, ['丁生'], 1, 5, '綠', 0],               // 家長沒綁 LINE
  ['990205', PHONE.p1, () => COACH_A, '家教1VS1', 1, ['甲生'], 0, 6, '紅', 0],               // 紅燈
  ['990206', PHONE.p1, () => COACH_DUP, '家教1VS1', 1, ['甲生'], 0, 6, '綠', 0],             // 教練同名兩位
  ['990207', PHONE.p1, () => COACH_A, '家教1VS1', 1, ['乙生'], 0, 6, '綠', 0],               // 已手動建過
  ['990208', PHONE.p3, () => COACH_A, '家教1VS1', 1, ['戊生'], 0, 6, '綠', 0],               // 櫃台待對帳中
  ['990209', PHONE.p1, () => COACH_A, '家教1VS1', 1, ['乙生'], 1, 4, '綠', 1],               // 有過期堂數
  ['990210', PHONE.p5, () => COACH_A, '家教1VS1 (50%)', 1, ['己生'], 0, 6, '綠', 0],         // 全符合（上限測試）
  ['990211', PHONE.p5, () => COACH_A, '家教1VS1', 1, ['己生'], 3, 3, '綠', 0],               // 全符合（上限測試）
];
const usesFor = (n) => Array.from({ length: n }, (_, k) => ({
  at: `2026-0${7 + k}-15T19:30:00+08:00`, coach: k === 0 ? COACH_B : '舊系統離職教練',
}));

async function seed() {
  for (const [seq, phone, coach, course, type, names, used, rem, light, expired] of PKGS) {
    await pool.query(
      `INSERT INTO yz_legacy_packages (seq, invoice, coach, student_names, member_code, course_name, course_type,
         total_sessions, remaining_sessions, used_sessions, uses, purchase_date, snapshot_at)
       VALUES ($1, NULL, $2, $3::text[], 'AQ0000', $4, $5, $6, $7, $8, $9::jsonb, '2025-08-21', $10)`,
      [seq, coach(), names, course, type, used + rem, rem, used, JSON.stringify(usesFor(used)), SNAP]);
    await pool.query(
      `INSERT INTO yz_legacy_package_meta (seq, phone, venue_id, light, expired_sessions) VALUES ($1, $2, $3, $4, $5)`,
      [seq, phone, venueId, light, expired]);
  }
}
async function addOrder(status, phone, extra = {}) {
  const id = `${T}${fixtureOrders.length}`.toUpperCase();
  fixtureOrders.push(id);
  await pool.query(
    `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
       original_price, final_price, status, submitted_at, total_sessions, used_sessions, period_count, period_number,
       payment_method, order_kind)
     VALUES ($1, '測試家長', $2, ARRAY['測試學員'], $3, $4, $5, 1, 0, 0, $6, NOW(), 6, 0, 1, 1, $7, 'standard')`,
    [id, phone, COACH_A, coachA, venueId, status, extra.paymentMethod || '舊系統轉移']);
  return id;
}
const rowOf = (r, seq) => r.rows.find((x) => x.seq === seq);
const transferred = async () => (await pool.query(
  `SELECT substring(external_order_no FROM 9) AS seq FROM admin_enrollments
    WHERE external_order_no LIKE 'ABLEPOS:9902%' ORDER BY 1`)).rows.map((r) => r.seq);

console.log('yazheng_auto_transfer_db_test');

(async () => {
  try {
    venueId = (await pool.query(`SELECT id FROM venues WHERE is_active IS NOT FALSE ORDER BY id LIMIT 1`)).rows[0].id;
    coachA = await addCoach(COACH_A);
    coachB = await addCoach(COACH_B);
    await addCoach(COACH_DUP);
    await addCoach(COACH_DUP);
    await addParent(PHONE.p1, true, ['甲生', '乙生']);
    await addParent(PHONE.p2, false, ['丁生']);
    await addParent(PHONE.p3, true, ['戊生']);
    await addParent(PHONE.p5, true, ['己生']);
    await seed();
    const manual = await addOrder('confirmed', PHONE.p1);
    await pool.query(`INSERT INTO yz_legacy_links (seq, enrollment_id, linked_by) VALUES ('990207', $1, '測試櫃台')`, [manual]);
    await addOrder('pending_payment', PHONE.p3);

    await check('購入係數依課名：(20%)＝1.2、(50%)＝1.5、沒標示＝1.0', async () => {
      assert.equal(auto.multiplierFor('家教1VS1 (20%)'), 1.2);
      assert.equal(auto.multiplierFor('家教1VS2（50%）'), 1.5);
      assert.equal(auto.multiplierFor('家教1VS1正'), 1.0);
    });

    await check('試跑：結果和真的跑一樣，但不留任何資料', async () => {
      const r = await auto.runAutoTransfer({ dryRun: true });
      assert.equal(r.dry_run, true);
      assert.deepEqual(r.transferred.filter((s) => s.startsWith('9902')), ['990201', '990210', '990211']);
      assert.deepEqual(await transferred(), []);
      const m = (await pool.query(`SELECT count(*)::int n FROM course_periods WHERE admin_enrollment_id LIKE 'ABL9902%'`)).rows[0].n;
      assert.equal(m, 0);
    });

    let first;
    await check('一次上限：limit=2 只轉前兩包，第三包記 RUN_LIMIT', async () => {
      first = await auto.runAutoTransfer({ limit: 2 });
      assert.deepEqual(first.transferred, ['990201', '990210']);
      assert.equal(rowOf(first, '990211').code, 'RUN_LIMIT');
      assert.deepEqual(await transferred(), ['990201', '990210']);
    });

    await check('每一種不符條件都跳過、留給櫃台（原因正確）', async () => {
      assert.equal(rowOf(first, '990202').code, 'STUDENT_COUNT_MISMATCH');
      assert.equal(rowOf(first, '990203').code, 'STUDENT_NOT_FOUND');
      assert.equal(rowOf(first, '990206').code, 'COACH_NOT_UNIQUE');
      assert.equal(rowOf(first, '990208').code, 'COUNTER_PENDING');
      assert.equal(rowOf(first, '990209').code, 'HAS_EXPIRED_SESSIONS');
      // 家長沒綁 LINE、紅燈、已手動建過：連候選都不是
      for (const seq of ['990204', '990205', '990207']) assert.equal(rowOf(first, seq), undefined, seq);
      assert.equal(first.errors, 0);
    });

    await check('建單形狀同 10/22 匯入工具：ABLEPOS 單號、確認、金額 0、係數、到期日、舊紀錄', async () => {
      const ae = (await pool.query(`SELECT * FROM admin_enrollments WHERE external_order_no = 'ABLEPOS:990201'`)).rows[0];
      assert.equal(ae.id, 'ABL990201');
      assert.deepEqual([ae.status, Number(ae.final_price), ae.total_sessions, ae.used_sessions, ae.course_type],
        ['confirmed', 0, 6, 2, 2]);
      assert.equal(Number(ae.purchased_pricing_multiplier), 1.2);
      assert.equal(ae.coach_id, coachA);
      assert.deepEqual([...ae.students].sort(), ['乙生', '甲生']);
      assert.match(ae.notes, /自動轉入｜單據序號 990201/);
      const cp = (await pool.query(
        `SELECT *, to_char(expires_at, 'YYYY-MM-DD') AS exp FROM course_periods WHERE admin_enrollment_id = $1`, [ae.id])).rows[0];
      assert.deepEqual([cp.status, cp.total_sessions, cp.used_sessions, cp.exp, cp.entitlement_state],
        ['active', 6, 2, auto.JOINED_EXPIRES, 'ACTIVE']);
      const ss = (await pool.query(
        `SELECT cs.coach_id::text AS coach, count(cr.*)::int AS n, bool_and(cr.checked_in_source = 'legacy_import') AS legacy
           FROM course_sessions cs JOIN checkin_records cr ON cr.course_session_id = cs.id
          WHERE cs.course_period_id = $1 GROUP BY cs.id, cs.coach_id, cs.scheduled_at ORDER BY cs.scheduled_at`, [cp.id])).rows;
      assert.equal(ss.length, 2);
      assert.deepEqual(ss.map((s) => s.coach), [coachB, coachA]); // 第一堂舊教練在新系統有同名，第二堂用課期教練
      assert.ok(ss.every((s) => s.n === 2 && s.legacy));
      const logs = (await pool.query(`SELECT action, by_user FROM admin_enrollment_audit_logs WHERE enrollment_id = $1`, [ae.id])).rows;
      assert.equal(logs.length, 1);
      assert.match(logs[0].action, /自動轉入：共 6 堂、補 2 筆舊上課紀錄、剩 4 堂/);
    });

    await check('重跑：已轉的不再轉，上次因上限沒轉的這次轉', async () => {
      const r = await auto.runAutoTransfer();
      assert.deepEqual(r.transferred, ['990211']);
      assert.deepEqual(await transferred(), ['990201', '990210', '990211']);
      const r2 = await auto.runAutoTransfer();
      assert.deepEqual(r2.transferred, []);
    });

    await check('轉入後算「已建過」：櫃台改打這個舊單號會被擋', async () => {
      const built = await yz.builtMap(pool, ['990201']);
      assert.equal(built.get('990201').source, 'import');
      const m = await yz.matchLegacy(pool, [{ coach: COACH_A }], { seqs: '990201' });
      assert.equal(m.ok, false);
      assert.deepEqual(m.selectable, []);
    });

    await check('櫃台那張待對帳取消後，下次就自動轉', async () => {
      await pool.query(`UPDATE admin_enrollments SET status = 'cancelled' WHERE parent_phone = $1 AND id = ANY($2)`, [PHONE.p3, fixtureOrders]);
      const r = await auto.runAutoTransfer();
      assert.deepEqual(r.transferred, ['990208']);
    });

    await check('同步：轉入的單在對帳清單帶出舊單號（GPT 網站與小助理靠這個）', async () => {
      const { orders } = await listOrders({ since: new Date(Date.now() - 3600e3).toISOString(), limit: 1000 });
      const o = orders.find((x) => x.enrollment_id === 'ABL990201');
      assert.ok(o, '對帳清單應該有 ABL990201');
      assert.deepEqual(o.legacy_seqs, ['990201']);
    });

    await check('YZ_AUTO_TRANSFER=off 會關掉', async () => {
      assert.equal(auto.enabled({ YZ_AUTO_TRANSFER: 'off' }), false);
      assert.equal(auto.enabled({}), true);
    });
  } finally {
    const orders = (await pool.query(`SELECT id FROM admin_enrollments WHERE external_order_no LIKE 'ABLEPOS:9902%'`)).rows.map((r) => r.id);
    const all = [...orders, ...fixtureOrders];
    const periods = (await pool.query(`SELECT id FROM course_periods WHERE admin_enrollment_id = ANY($1)`, [all])).rows.map((r) => r.id);
    await pool.query(`DELETE FROM checkin_records WHERE course_session_id IN (SELECT id FROM course_sessions WHERE course_period_id = ANY($1::uuid[]))`, [periods]).catch(() => {});
    await pool.query(`DELETE FROM course_sessions WHERE course_period_id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pool.query(`DELETE FROM course_period_enrollments WHERE course_period_id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pool.query(`DELETE FROM course_periods WHERE id = ANY($1::uuid[])`, [periods]).catch(() => {});
    await pool.query(`DELETE FROM yz_legacy_links WHERE seq LIKE '9902%'`).catch(() => {});
    await pool.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1)`, [all]).catch(() => {});
    await pool.query(`DELETE FROM admin_enrollments WHERE id = ANY($1)`, [all]).catch(() => {});
    await pool.query(`DELETE FROM yz_legacy_package_meta WHERE seq LIKE '9902%'`).catch(() => {});
    await pool.query(`DELETE FROM yz_legacy_packages WHERE seq LIKE '9902%'`).catch(() => {});
    for (const id of parentIds) {
      await pool.query(`DELETE FROM students WHERE parent_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM parents WHERE id = $1`, [id]).catch(() => {});
    }
    await pool.query(`DELETE FROM coaches WHERE id::text = ANY($1)`, [coachIds]).catch(() => {});
    await pool.end();
  }
  if (failures) { console.error(`yazheng_auto_transfer_db_test: ${failures} 項失敗`); process.exit(1); }
  console.log('yazheng_auto_transfer_db_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
