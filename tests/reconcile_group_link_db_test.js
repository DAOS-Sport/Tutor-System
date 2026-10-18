'use strict';
// 對帳清單的「同團」摘要：readCheckout 要帶出這張付款單屬於哪一團、審核到哪、
// 同團共幾家、其中還有幾家沒對完帳。
//
// 為什麼需要：核准團購時是「每個家庭一張 checkout」（routes/admin/groupOrders.js 的
// approve），櫃檯在待對帳清單會看到散開的 N 筆，沒有任何線索知道它們是同一團。
// 家數一定要由後端算：對帳清單只載入「待對帳」的，同團已經對完的那幾家不在清單裡，
// 前端自己數會把 3 家的團講成 1 家。
//
// 真實 public schema、合成資料、try/finally 自己刪乾淨。不碰 LINE / Ragic / 正式資料。
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../server/node_modules/pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), '必須是 loopback 的拋棄式測試庫');
assert.match(target.pathname, /^\/daos_(test|audit)/, '必須是 daos_test / daos_audit');

const pool = new Pool({ connectionString: url, options: '-c statement_timeout=20000' });
const { readCheckout } = require('../server/services/checkouts');

let passed = 0;
const made = { groups: [], checkouts: [], enrollments: [], parents: [] };
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };

async function ctx() {
  const venue = (await pool.query(
    'SELECT id FROM admin_venues WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1')).rows[0].id;
  const coach = (await pool.query(
    'SELECT id FROM coaches WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1')).rows[0].id;
  return { venue, coach };
}

async function makeParent() {
  const id = randomUUID();
  made.parents.push(id);
  await pool.query('INSERT INTO parents(id, phone, name, is_active) VALUES ($1, $2, $3, TRUE)',
    [id, 'grp-' + randomUUID().slice(-12), '測試家長']);
  return id;
}

/** 建一團＋每個家庭一張 checkout（照 approve 的實際形狀）。 */
async function makeGroup({ status = 'approved', families = 2, pending = null }, env) {
  const groupId = randomUUID();
  made.groups.push(groupId);
  const leader = await makeParent();
  await pool.query(
    `INSERT INTO group_orders(id, leader_parent_id, venue_id, course_type, coach_id, status,
                              join_token, min_students, max_students, reviewed_at)
     VALUES ($1, $2, $3, 1, $4, $5, $6, 1, 6, NOW())`,
    [groupId, leader, env.venue, env.coach, status, 'tok-' + randomUUID()]);

  const stillPending = pending == null ? families : pending;
  const checkouts = [];
  for (let i = 0; i < families; i += 1) {
    const parent = i === 0 ? leader : await makeParent();
    const checkoutId = randomUUID();
    const eid = 'grp-test-' + randomUUID();
    made.checkouts.push(checkoutId);
    made.enrollments.push(eid);
    await pool.query(
      `INSERT INTO checkout_sessions(checkout_id, parent_id, total_amount, payment_status)
       VALUES ($1, $2, 1000, $3)`,
      [checkoutId, parent, i < stillPending ? 'pending_reconcile' : 'paid']);
    await pool.query(
      `INSERT INTO admin_enrollments
         (id, status, checkout_id, parent_name, parent_phone, coach, coach_id, students,
          venue_id, course_type, original_price, final_price, period_number,
          total_sessions, used_sessions, submitted_at, group_order_id)
       VALUES ($1,'confirmed',$2,$3,$4,$5,$6,$7,$8,1,1000,1000,1,6,0,NOW(),$9)`,
      [eid, checkoutId, '測試家長' + i, 'grp-phone', '測試教練', env.coach,
        ['測試學員' + i], env.venue, groupId]);
    checkouts.push(checkoutId);
  }
  return { groupId, checkouts };
}

/** 不屬於任何團的一般付款單。 */
async function makeSolo(env) {
  const parent = await makeParent();
  const checkoutId = randomUUID();
  const eid = 'solo-test-' + randomUUID();
  made.checkouts.push(checkoutId);
  made.enrollments.push(eid);
  await pool.query(
    `INSERT INTO checkout_sessions(checkout_id, parent_id, total_amount, payment_status)
     VALUES ($1, $2, 1000, 'pending_reconcile')`, [checkoutId, parent]);
  await pool.query(
    `INSERT INTO admin_enrollments
       (id, status, checkout_id, parent_name, parent_phone, coach, coach_id, students,
        venue_id, course_type, original_price, final_price, period_number,
        total_sessions, used_sessions, submitted_at)
     VALUES ($1,'confirmed',$2,$3,$4,$5,$6,$7,$8,1,1000,1000,1,6,0,NOW())`,
    [eid, checkoutId, '單獨家長', 'solo-phone', '測試教練', env.coach, ['單獨學員'], env.venue]);
  return checkoutId;
}

(async () => {
  const env = await ctx();
  try {
    await t('已核准的團：帶出團 id、狀態、同團家數', async () => {
      const g = await makeGroup({ status: 'approved', families: 3 }, env);
      const c = await readCheckout(pool, g.checkouts[0]);
      assert.ok(c.group_order, '沒有帶出 group_order');
      assert.equal(c.group_order.id, g.groupId);
      assert.equal(c.group_order.status, 'approved');
      assert.equal(c.group_order.checkout_count, 3, '同團家數不對');
      assert.equal(typeof c.group_order.checkout_count, 'number', '家數必須是數字（字串會讓前端比較失準）');
    });

    await t('同團已對完帳的不算進待對帳數（前端自己數會少算）', async () => {
      const g = await makeGroup({ status: 'approved', families: 3, pending: 1 }, env);
      const c = await readCheckout(pool, g.checkouts[0]);
      assert.equal(c.group_order.checkout_count, 3, '總家數應該是 3');
      assert.equal(c.group_order.pending_checkout_count, 1, '待對帳家數應該是 1');
    });

    await t('同團的每一張付款單都拿到同一份摘要', async () => {
      const g = await makeGroup({ status: 'approved', families: 2 }, env);
      const [a, b] = await Promise.all(g.checkouts.map((id) => readCheckout(pool, id)));
      assert.deepEqual(a.group_order, b.group_order, '同團兩張付款單的摘要不一致');
    });

    await t('一個家庭多筆子訂單，家數仍然是 1（用 checkout 算不是用子訂單算）', async () => {
      const g = await makeGroup({ status: 'approved', families: 1 }, env);
      // 同一張 checkout 再掛兩筆子訂單（多位學員／多期就是這個形狀）
      for (let i = 0; i < 2; i += 1) {
        const eid = 'grp-extra-' + randomUUID();
        made.enrollments.push(eid);
        await pool.query(
          `INSERT INTO admin_enrollments
             (id, status, checkout_id, parent_name, parent_phone, coach, coach_id, students,
              venue_id, course_type, original_price, final_price, period_number,
              total_sessions, used_sessions, submitted_at, group_order_id)
           VALUES ($1,'confirmed',$2,$3,$4,$5,$6,$7,$8,1,1000,1000,$9,6,0,NOW(),$10)`,
          [eid, g.checkouts[0], '測試家長', 'grp-phone', '測試教練', env.coach,
            ['加掛學員' + i], env.venue, i + 2, g.groupId]);
      }
      const c = await readCheckout(pool, g.checkouts[0]);
      assert.equal(c.group_order.checkout_count, 1,
        '把子訂單數當成家數了：實際 ' + c.group_order.checkout_count);
      assert.ok(c.sub_orders.length >= 3, 'fixture 沒建成多筆子訂單');
    });

    await t('未核准的團：狀態照實回報（前端據此不顯示入口）', async () => {
      const g = await makeGroup({ status: 'submitted', families: 2 }, env);
      const c = await readCheckout(pool, g.checkouts[0]);
      assert.equal(c.group_order.status, 'submitted', '狀態被改寫成 approved 了');
    });

    await t('不是團購的付款單 → group_order 為 null', async () => {
      const id = await makeSolo(env);
      const c = await readCheckout(pool, id);
      assert.equal(c.group_order, null, '非團購卻帶出了 group_order');
    });

    await t('獨立重算：家數與待對帳數＝自己查一遍的結果', async () => {
      const g = await makeGroup({ status: 'approved', families: 4, pending: 2 }, env);
      const c = await readCheckout(pool, g.checkouts[0]);
      const want = (await pool.query(
        `SELECT COUNT(DISTINCT ae.checkout_id)::int AS total,
                COUNT(DISTINCT ae.checkout_id) FILTER (
                  WHERE cs.payment_status IN ('pending_payment','pending_reconcile'))::int AS pending
           FROM admin_enrollments ae
           JOIN checkout_sessions cs ON cs.checkout_id = ae.checkout_id
          WHERE ae.group_order_id = $1`, [g.groupId])).rows[0];
      assert.equal(c.group_order.checkout_count, want.total);
      assert.equal(c.group_order.pending_checkout_count, want.pending);
    });

    console.log(`\n${passed} 個測試全數通過`);
  } finally {
    try {
      for (const id of made.enrollments) await pool.query('DELETE FROM admin_enrollments WHERE id = $1', [id]);
      for (const id of made.checkouts) await pool.query('DELETE FROM checkout_sessions WHERE checkout_id = $1', [id]);
      for (const id of made.groups) await pool.query('DELETE FROM group_orders WHERE id = $1', [id]);
      for (const id of made.parents) await pool.query('DELETE FROM parents WHERE id = $1', [id]);
    } catch (e) {
      console.error('清除失敗：' + e.message);
      process.exitCode = 1;
    }
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
