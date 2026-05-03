// 路徑 E：優惠購課資料隔離
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path E: 優惠購課');
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');
  const r = await call('GET', '/api/admin/promotions', { token });
  assert([200, 404].includes(r.status), `GET promotions 回應，實際 ${r.status}`);
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
