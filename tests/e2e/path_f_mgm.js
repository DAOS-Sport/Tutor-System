// 路徑 F：MGM 完整路徑
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path F: MGM');
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');
  const r = await call('GET', '/api/admin/reports/mgm-conversion', { token });
  assert(r.status === 200, `mgm-conversion 200，實際 ${r.status}`);
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
