// 路徑 G：學習歷程（plan + record 完成率）
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path G: 學習歷程');
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');
  const r = await call('GET', '/api/admin/reports/learning-completion', { token });
  assert(r.status === 200, `learning-completion 200，實際 ${r.status}`);
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
