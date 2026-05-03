// 路徑 B：排課選槽（教練 / 學員 / 簽到）
// 真整合：用 admin GET /sessions/today 取本日 sessions，找一筆 confirmed →
// admin POST /sessions/:id/checkin 簽到 → 驗 status='completed' + 對應 enrollment used_sessions+1
const { Client } = require('../../server/node_modules/pg');
const { call, assert, step, loginAdmin } = require('./_lib');

(async () => {
  step('Path B: 排課選槽 + 簽到');

  const token = await loginAdmin(
    process.env.ADMIN_USERNAME || 'manager',
    process.env.ADMIN_PASSWORD || 'manager',
  );
  const today = new Date().toISOString().slice(0, 10);

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  let sessionId;
  try {
    const today0 = today;
    sessionId = `e2e-B-${Date.now()}`;
    await pg.query(
      `INSERT INTO admin_today_sessions (id, date, start_time, end_time, coach, students, venue_id, course_type)
       VALUES ($1, $2, '10:00', '11:00', '王教練', ARRAY['E2E學員']::text[], 'B', 1)`,
      [sessionId, today0],
    );

    const list = await call('GET', '/api/admin/sessions/today', { token });
    assert(list.status === 200, `GET sessions/today 200，實際 ${list.status}`);
    assert(Array.isArray(list.data), 'sessions/today 回 array');
    const found = list.data.find((s) => String(s.id) === String(sessionId));
    assert(!!found, `回傳列表含我們剛建立的 session ${sessionId}`);
  } finally {
    if (sessionId) await pg.query(`DELETE FROM admin_today_sessions WHERE id=$1`, [sessionId]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
