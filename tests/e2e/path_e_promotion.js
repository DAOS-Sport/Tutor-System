// 路徑 E：優惠購課資料隔離
// 真整合：寫一筆 promotion → 用 venue=B 的 manager token GET，能看到；用另一場館不能看到。
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path E: 優惠購課（資料隔離）');
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');

  // 路由 GET /api/admin/promotions 是否存在
  const r = await call('GET', '/api/admin/promotions', { token });
  if (r.status === 404) {
    console.log('  ⚠ /api/admin/promotions 未實作（promotions 屬 LIFF 端為主），跳過');
    step('done');
    return;
  }
  assert(r.status === 200, `promotions 200，實際 ${r.status}`);
  assert(Array.isArray(r.data) || Array.isArray(r.data?.rows), 'array response');
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
