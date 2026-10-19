'use strict';
// #12 假成功稽核 · 需要真實 Postgres 的兩條契約（真實路由 handler + 真實 public schema）。
//
//   A. 團主取消團購：狀態轉 cancelled、優惠名額回沖，必須在同一交易。
//      以前回沖是 COMMIT 後的 best-effort `.catch(() => console.warn)`：
//      回沖失敗時家長看到「團購已取消」，優惠名額卻永遠被佔著，沒有人會發現。
//      A1 正常取消 → 200，usage 刪掉、promotions.current_uses 扣回。
//      A2 回沖丟錯 → 500，團購仍是 forming、沒有寫「團主取消」稽核、usage 原封不動。
//   B. 系統設定 PATCH：以前不認得的 key 直接略過、照回 200（畫面說「已儲存」其實沒存），
//      而且邊驗邊寫，第三個值不合法時前兩個已經寫進去了。
//      B1 未知 key → 400，任何值都不動。
//      B2 合法 key 後面接一個非數字 → 400，前面的合法值也不能被寫入。
//
// 不起 HTTP server、不碰 LINE / Ragic；自己建的列在 finally 全部刪掉。
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../server/node_modules/pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), '必須是 loopback 的拋棄式測試庫');
assert.match(target.pathname, /^\/daos_(test|audit)/, '必須是 daos_test / daos_audit');

const pool = new Pool({ connectionString: url, options: '-c statement_timeout=20000' });

function stub(name, exports) {
  const id = require.resolve('../server/' + name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('models/db', { pool });

function route(mod, method, path) {
  const m = require('../server/routes/' + mod);
  const layer = m.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `找不到路由 ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}
async function call(handler, req) {
  let status = 200; let body;
  const res = { status(c) { status = c; return this; }, json(d) { body = d; return this; } };
  await handler({ params: {}, query: {}, body: {}, get: () => '', ...req }, res);
  return { status, body };
}

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };

(async () => {
  const promotions = require('../server/services/promotions');
  const cancel = route('groupOrders', 'post', '/:id/cancel');
  const patchSettings = route('admin/settings', 'patch', '/');

  const parentId = randomUUID();
  const promoId = randomUUID();
  const orders = [];
  const settingKeys = ['transfer_fee', 'refund_fee_rate'];
  const savedSettings = (await pool.query(
    'SELECT key, value FROM admin_settings WHERE key = ANY($1)', [settingKeys])).rows;

  async function makeOrder() {
    const id = randomUUID();
    orders.push(id);
    await pool.query(
      `INSERT INTO group_orders (id, leader_parent_id, venue_id, course_type, status, join_token, promotion_id)
       VALUES ($1,$2,(SELECT id FROM admin_venues ORDER BY id LIMIT 1),3,'forming',$3,$4)`,
      [id, parentId, 'fs-' + id, promoId]);
    await pool.query(
      `INSERT INTO promotion_usages (promotion_id, parent_id, original_price, discount_amount, final_price, used_periods, group_order_id)
       VALUES ($1,$2,1000,100,900,1,$3)`, [promoId, parentId, id]);
    await pool.query('UPDATE promotions SET current_uses = current_uses + 1, current_period_uses = current_period_uses + 1 WHERE id = $1', [promoId]);
    return id;
  }
  const uses = async () => (await pool.query('SELECT current_uses FROM promotions WHERE id = $1', [promoId])).rows[0].current_uses;

  try {
    await pool.query('INSERT INTO parents (id, phone, name, is_active) VALUES ($1,$2,$3,TRUE)',
      [parentId, 'fs-' + parentId.slice(0, 12), '假成功測試家長']);
    await pool.query(
      `INSERT INTO promotions (id, name, type, discount_value, start_date, end_date, status)
       VALUES ($1,'假成功測試優惠','FIXED_AMOUNT',100,NOW() - INTERVAL '1 day',NOW() + INTERVAL '1 day','active')`, [promoId]);

    await t('A1 團主取消：200、狀態 cancelled、名額同交易回沖', async () => {
      const id = await makeOrder();
      const before = await uses();
      const r = await call(cancel, { params: { id }, parent: { id: parentId } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await pool.query('SELECT status FROM group_orders WHERE id = $1', [id])).rows[0].status, 'cancelled');
      assert.equal((await pool.query('SELECT 1 FROM promotion_usages WHERE group_order_id = $1', [id])).rowCount, 0);
      assert.equal(await uses(), before - 1);
    });

    await t('A2 名額回沖失敗：500，取消不落地、usage 不動、不寫稽核', async () => {
      const id = await makeOrder();
      const before = await uses();
      const orig = promotions.revertUsage;
      promotions.revertUsage = async () => { throw new Error('injected revert failure'); };
      const errLog = console.error; console.error = () => {};
      let r;
      try { r = await call(cancel, { params: { id }, parent: { id: parentId } }); }
      finally { promotions.revertUsage = orig; console.error = errLog; }
      assert.equal(r.status, 500, '回沖失敗不可以回成功');
      assert.equal((await pool.query('SELECT status FROM group_orders WHERE id = $1', [id])).rows[0].status, 'forming');
      assert.equal((await pool.query('SELECT 1 FROM promotion_usages WHERE group_order_id = $1', [id])).rowCount, 1);
      assert.equal((await pool.query(
        `SELECT 1 FROM group_order_audit_logs WHERE group_order_id = $1 AND action = '團主取消'`, [id])).rowCount, 0);
      assert.equal(await uses(), before);
    });

    await t('A3 非團主取消：403（不受交易改寫影響）', async () => {
      const id = await makeOrder();
      const r = await call(cancel, { params: { id }, parent: { id: randomUUID() } });
      assert.equal(r.status, 403);
    });

    const snapshot = async () => Object.fromEntries((await pool.query(
      'SELECT key, value::text FROM admin_settings WHERE key = ANY($1)', [settingKeys])).rows.map((x) => [x.key, x.value]));

    await t('B1 系統設定：未知 key → 400，什麼都不寫', async () => {
      const before = await snapshot();
      const r = await call(patchSettings, { body: { transfer_fee: 4321, not_a_real_setting: 1 } });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'SETTING_KEY_UNKNOWN');
      assert.deepEqual(await snapshot(), before, '有任何一個 key 不合法，就不可以寫入其他 key');
    });

    await t('B2 系統設定：合法值後面接非數字 → 400，前面的合法值也不落地', async () => {
      const before = await snapshot();
      const r = await call(patchSettings, { body: { transfer_fee: 4322, refund_fee_rate: 'abc' } });
      assert.equal(r.status, 400);
      assert.deepEqual(await snapshot(), before);
    });

    await t('B3 系統設定：全部合法 → 200 並回傳寫入後的值', async () => {
      const r = await call(patchSettings, { body: { transfer_fee: 4323 } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.transfer_fee, 4323);
    });
  } finally {
    if (orders.length) {
      await pool.query('DELETE FROM promotion_usages WHERE group_order_id = ANY($1)', [orders]);
      await pool.query('DELETE FROM group_order_audit_logs WHERE group_order_id = ANY($1)', [orders]);
      await pool.query('DELETE FROM group_orders WHERE id = ANY($1)', [orders]);
    }
    await pool.query('DELETE FROM promotions WHERE id = $1', [promoId]);
    await pool.query('DELETE FROM parents WHERE id = $1', [parentId]);
    // 還原系統設定：原本有的值寫回，原本沒有的 key 刪掉。
    await pool.query('DELETE FROM admin_settings WHERE key = ANY($1)', [settingKeys]);
    for (const row of savedSettings) {
      await pool.query('INSERT INTO admin_settings (key, value, updated_at) VALUES ($1,$2,NOW())', [row.key, row.value]);
    }
    await pool.end();
  }
  console.log(`\n${passed} passed`);
})().catch((err) => { console.error('FAIL', err); process.exitCode = 1; });
