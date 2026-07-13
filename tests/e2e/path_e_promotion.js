// 路徑 E：優惠完整生命週期 + 角色授權測試
// 1) admin 建一筆 promotion（venue_id=B 限定）→ submit → manager approve → 驗 status=active
// 2) 角色授權：staff 角色不可 approve → 驗 403
// 3) manager 依既有 admin/manager 生命週期規則可 approve → 驗 200
// 4) DB row 驗 applicable_venue_ids=['B']（前端 / staff 端依此過濾）
// 5) archive → 驗 status=archived
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path E: 優惠生命週期 + 角色授權');
  const adminToken = await loginAdmin('admin', process.env.ADMIN_ADMIN_PASSWORD || 'admin');
  const managerToken = await loginAdmin('manager', process.env.ADMIN_PASSWORD || 'manager');
  const staffToken = await loginAdmin('staff', process.env.ADMIN_STAFF_PASSWORD || 'staff');

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

    // staff 不可建立優惠（角色守門）
    const staffCreate = await call('POST', '/api/admin/promotions', {
      token: staffToken,
      body: { name: 'X', type: 'PERCENTAGE', discount_value: 0.9, start_date: today, end_date: next },
    });
    assert(staffCreate.status === 403, `staff POST 403，實際 ${staffCreate.status}`);

    const sub = await call('POST', `/api/admin/promotions/${pid}/submit`, { token: adminToken });
    assert(sub.status === 200, `submit 200`);

    // staff 不可 approve
    const stApp = await call('POST', `/api/admin/promotions/${pid}/approve`, { token: staffToken });
    assert(stApp.status === 403, `staff approve 403，實際 ${stApp.status}`);

    // baseline route 的既有規則是 admin/manager 皆可管理完整生命週期。
    const mgrApp = await call('POST', `/api/admin/promotions/${pid}/approve`, { token: managerToken });
    assert(mgrApp.status === 200, `manager approve 200，實際 ${mgrApp.status}`);

    const dbRow = await pg.query(`SELECT status, applicable_venue_ids FROM promotions WHERE id=$1`, [pid]);
    assert(dbRow.rows[0].status === 'active', `DB status=active`);
    assert(Array.isArray(dbRow.rows[0].applicable_venue_ids)
      && dbRow.rows[0].applicable_venue_ids.includes('B')
      && !dbRow.rows[0].applicable_venue_ids.includes('A'),
      '場館隔離：applicable_venue_ids=[B]');

    const arch = await call('POST', `/api/admin/promotions/${pid}/archive`, { token: adminToken });
    assert(arch.status === 200, `archive 200`);
    const after = await pg.query(`SELECT status FROM promotions WHERE id=$1`, [pid]);
    assert(after.rows[0].status === 'archived', `archived`);
  } finally {
    if (pid) {
      await pg.query(`DELETE FROM promotion_audit_logs WHERE promotion_id=$1`, [pid]).catch(() => {});
      await pg.query(`DELETE FROM promotions WHERE id=$1`, [pid]);
    }
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
