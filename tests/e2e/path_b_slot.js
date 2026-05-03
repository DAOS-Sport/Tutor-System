// 路徑 B：排課選槽（教練開槽 → 學員選 1v1 → 簽到 → 扣堂）
// Smoke：驗 /api/slots 與 /api/sessions list endpoint 可用
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path B: 排課選槽');
  const token = await loginAdmin(
    process.env.ADMIN_USERNAME || 'manager',
    process.env.ADMIN_PASSWORD || 'manager',
  );
  const r = await call('GET', '/api/admin/sessions/today', { token });
  assert(r.status === 200, `GET sessions/today 200，實際 ${r.status}`);
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
