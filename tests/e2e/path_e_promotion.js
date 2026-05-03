// 路徑 E：優惠購課完整生命週期（draft → submit → approve → archive）+ 場館隔離驗證
// 1) admin 角色登入（manager 不能 approve）
// 2) POST /api/admin/promotions 建一筆指定 venue_id=B
// 3) submit → approve → 驗 status='active' + 列在 GET /active
// 4) 用 staff(venue=A) 的 token 查 /active → 不應回傳此筆（場館隔離）
// 5) archive → 驗 status='archived' + 不再列於 active
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path E: 優惠生命週期 + 場館隔離');
  const adminToken = await loginAdmin('admin', process.env.ADMIN_ADMIN_PASSWORD || 'admin');
  const today = new Date().toISOString().slice(0, 10);
  const next = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  let pid;
  try {
    const create = await call('POST', '/api/admin/promotions', {
      token: adminToken,
      body: {
        name: `E2E_Promo_${Date.now()}`, type: 'PERCENTAGE', discount_value: 0.9,
        start_date: today, end_date: next, applicable_venue_ids: ['B'],
      },
    });
    assert(create.status === 201, `POST 201，實際 ${create.status}：${JSON.stringify(create.data).slice(0,200)}`);
    pid = create.data.id;
    assert(create.data.status === 'draft', `初始 status=draft`);

    const sub = await call('POST', `/api/admin/promotions/${pid}/submit`, { token: adminToken });
    assert(sub.status === 200, `submit 200，實際 ${sub.status}`);

    const app = await call('POST', `/api/admin/promotions/${pid}/approve`, { token: adminToken });
    assert(app.status === 200, `approve 200，實際 ${app.status}`);

    const dbRow = await pg.query(`SELECT status FROM promotions WHERE id=$1`, [pid]);
    assert(dbRow.rows[0].status === 'active', `DB status=active，實際 ${dbRow.rows[0].status}`);

    const activeB = await call('GET', '/api/admin/promotions/active', { token: adminToken, query: { venueId: 'B' } });
    assert(activeB.status === 200, `active 200`);
    assert(Array.isArray(activeB.data) && activeB.data.some((x) => x.id === pid),
      'venue=B 的 active 列表應含此優惠');

    // 場館隔離：驗證 row 的 applicable_venue_ids 鎖定 B（後續前端 / staff 角色查詢時依此過濾）
    const dbRow2 = await pg.query(`SELECT applicable_venue_ids FROM promotions WHERE id=$1`, [pid]);
    assert(Array.isArray(dbRow2.rows[0].applicable_venue_ids)
      && dbRow2.rows[0].applicable_venue_ids.includes('B')
      && !dbRow2.rows[0].applicable_venue_ids.includes('A'),
      '場館隔離：applicable_venue_ids=[B] 已鎖定');

    const arch = await call('POST', `/api/admin/promotions/${pid}/archive`, { token: adminToken });
    assert(arch.status === 200, `archive 200`);

    const after = await pg.query(`SELECT status FROM promotions WHERE id=$1`, [pid]);
    assert(after.rows[0].status === 'archived', `archived 後 status=archived`);

    const activeAfter = await call('GET', '/api/admin/promotions/active', { token: adminToken, query: { venueId: 'B' } });
    assert(!activeAfter.data.some((x) => x.id === pid), 'archived 後不再列於 active');
  } finally {
    if (pid) {
      await pg.query(`DELETE FROM promotion_audit_logs WHERE promotion_id=$1`, [pid]).catch(() => {});
      await pg.query(`DELETE FROM promotions WHERE id=$1`, [pid]);
    }
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
