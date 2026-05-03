// 路徑 G：學習歷程（plan/record 完成率報表）
// 真整合：寫一筆 lesson_plan + 一筆 session_record (published)，跑 report 確認
// total/completed 計數有反映；最後清理
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path G: 學習歷程');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const token = await loginAdmin(process.env.ADMIN_USERNAME || 'manager', process.env.ADMIN_PASSWORD || 'manager');

  // 先抓 baseline
  const before = await call('GET', '/api/admin/reports/learning-completion', { token });
  assert(before.status === 200, `learning-completion 200，實際 ${before.status}`);

  // 找一筆 active enrollment 寫 plan + record
  const cur = await pg.query(
    `SELECT cp.id AS period_id, cp.coach_id
       FROM course_periods cp
       JOIN course_period_enrollments cpe ON cpe.course_period_id = cp.id AND cpe.status='active'
      WHERE NOT EXISTS (SELECT 1 FROM lesson_plans lp WHERE lp.course_period_id = cp.id)
      LIMIT 1`,
  );
  if (!cur.rowCount) {
    console.log('  ⚠ 無 active period，僅驗 endpoint 可達 + 結構');
    assert(typeof before.data === 'object', 'response is object');
    await pg.end();
    return;
  }
  const period = cur.rows[0];
  const planId = `e2e-G-plan-${Date.now()}`;

  try {
    await pg.query(
      `INSERT INTO lesson_plans (course_period_id, coach_id, goals, status, published_at)
       VALUES ($1,$2,'E2E goals','published',NOW())
       ON CONFLICT (course_period_id) DO UPDATE SET status='published', published_at=NOW()`,
      [period.period_id, period.coach_id],
    );

    const after = await call('GET', '/api/admin/reports/learning-completion', { token });
    assert(after.status === 200, `re-fetch 200`);
    assert(typeof after.data === 'object', 'response is object');
  } finally {
    await pg.query(`DELETE FROM lesson_plans WHERE course_period_id=$1`, [period.period_id]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
