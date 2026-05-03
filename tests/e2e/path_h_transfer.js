// 路徑 H：課程轉讓（家長申請 → 主管審 → 通過）
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path H: 課程轉讓');
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');
  const r = await call('GET', '/api/admin/transfers', { token, query: { status: 'pending' } });
  assert(r.status === 200, `admin/transfers 200，實際 ${r.status}`);
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
