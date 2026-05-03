// 路徑 A：核心購課（家長報名 → 末5碼 → 主管對帳 → 開通 → Flex）
// Smoke 版本：只驗 admin 端 reconcile API 流程，不觸發真實 LINE 推播。
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path A: 核心購課');
  const username = process.env.ADMIN_USERNAME || 'manager';
  const password = process.env.ADMIN_PASSWORD || 'manager';
  const token = await loginAdmin(username, password);
  assert(token, 'admin 登入取得 JWT');

  const r = await call('GET', '/api/admin/enrollments', {
    token, query: { status: 'pending' },
  });
  assert(r.status === 200, `GET enrollments 200，實際 ${r.status}`);
  assert(Array.isArray(r.data?.rows || r.data), 'enrollments 回傳列表');

  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
