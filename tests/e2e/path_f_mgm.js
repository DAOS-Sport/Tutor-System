// 路徑 F：MGM 完整路徑
// 真整合：呼叫 mgm-conversion 報表並驗 response shape；計算當前 referral 數
// （無法在不模擬完整 LIFF + LINE 註冊流程下程式化建立 referee，故僅驗 query 健康性）
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path F: MGM 漏斗報表');
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  let totalReferrals = 0;
  try {
    const r = await pg.query(`SELECT COUNT(*)::int AS n FROM referrals`).catch(() => ({ rows: [{ n: 0 }] }));
    totalReferrals = r.rows[0].n;
  } finally {
    await pg.end();
  }

  const r = await call('GET', '/api/admin/reports/mgm-conversion', { token });
  assert(r.status === 200, `mgm-conversion 200，實際 ${r.status}`);
  assert(r.data && typeof r.data.kpis === 'object', 'response 含 kpis 物件');
  assert(typeof r.data.kpis.total_links === 'number', 'kpis.total_links 為數字');
  console.log(`  ℹ DB referrals 總數 = ${totalReferrals}`);
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
