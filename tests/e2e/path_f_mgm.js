// 路徑 F：MGM 漏斗完整流程（真整合）
// 1) 取一位 coach + 一位 referrer parent
// 2) 直接 INSERT referral_records 模擬五段狀態各一筆：pending / registered / trial_paid / checked_in / reward_issued
// 3) 呼叫 /api/admin/mgm-stats → 驗 total++、byStatus 各值對齊、conversionRate 為非負數
// 4) 呼叫 /api/admin/reports/mgm-conversion → 驗 kpis.total_links 涵蓋
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path F: MGM 漏斗 5 段');
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const ref = await pg.query(`SELECT id FROM parents LIMIT 1`);
  const co = await pg.query(`SELECT id FROM coaches LIMIT 1`);
  if (!ref.rowCount || !co.rowCount) {
    console.log('  ⚠ 無 parents/coaches 種子，跳過寫入測試');
    const r = await call('GET', '/api/admin/mgm-stats', { token });
    assert(r.status === 200, `mgm-stats 200`);
    await pg.end(); step('done'); return;
  }
  const parentId = ref.rows[0].id;
  const coachId = co.rows[0].id;

  const before = await call('GET', '/api/admin/mgm-stats', { token, query: { coachId } });
  assert(before.status === 200, `before 200`);

  const ids = [];
  const phases = ['pending', 'registered', 'trial_paid', 'checked_in', 'reward_issued'];
  try {
    for (const status of phases) {
      const r = await pg.query(
        `INSERT INTO referral_records (token, referrer_parent_id, coach_id, referee_phone, status,
                                        registered_at, trial_paid_at, checked_in_at, reward_issued_at)
         VALUES ($1::varchar, $2, $3, $4::varchar, $5::varchar,
                 CASE WHEN $5 IN ('registered','trial_paid','checked_in','reward_issued') THEN NOW() ELSE NULL END,
                 CASE WHEN $5 IN ('trial_paid','checked_in','reward_issued') THEN NOW() ELSE NULL END,
                 CASE WHEN $5 IN ('checked_in','reward_issued') THEN NOW() ELSE NULL END,
                 CASE WHEN $5 = 'reward_issued' THEN NOW() ELSE NULL END)
         RETURNING id`,
        [`e2e_${Date.now()}_${status}`, parentId, coachId, `09${Math.random().toString().slice(2,10)}`, status],
      );
      ids.push(r.rows[0].id);
    }

    const after = await call('GET', '/api/admin/mgm-stats', { token, query: { coachId } });
    assert(after.status === 200, `after 200`);
    assert(after.data.total >= before.data.total + 5,
      `total 增加 ≥5：${before.data.total} → ${after.data.total}`);
    for (const s of phases) {
      assert((after.data.byStatus[s] || 0) >= (before.data.byStatus?.[s] || 0) + 1,
        `byStatus.${s} 至少 +1`);
    }
    assert(typeof after.data.conversionRate === 'number' && after.data.conversionRate >= 0,
      'conversionRate 為非負數');

    const conv = await call('GET', '/api/admin/reports/mgm-conversion', { token });
    assert(conv.status === 200, `mgm-conversion 200`);
    assert(typeof conv.data.kpis?.total_links === 'number', 'kpis.total_links 數字');
  } finally {
    if (ids.length) await pg.query(`DELETE FROM referral_records WHERE id = ANY($1::uuid[])`, [ids]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
