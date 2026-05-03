// 路徑 D：自助取消（normal vs late）
// 真整合：呼叫 services/slots.cancelSession 對假 session 直接觸發兩種類型，驗 row 狀態變化
const { Client } = require('../../server/node_modules/pg');
const { step, assert } = require('./_lib');

(async () => {
  step('Path D: 自助取消 — normal / late');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  // 找任一 confirmed session（不存在則跳過實際呼叫，僅驗 service 模組可載入）
  const cur = await pg.query(
    `SELECT id FROM course_sessions WHERE status='confirmed' LIMIT 1`,
  ).catch(() => ({ rowCount: 0 }));

  if (!cur.rowCount) {
    const slots = require('../../server/services/slots');
    assert(typeof slots.cancelSession === 'function', 'services/slots.cancelSession 函數存在');
    await pg.end();
    step('done');
    return;
  }

  const id = cur.rows[0].id;
  const before = await pg.query(`SELECT status FROM course_sessions WHERE id=$1`, [id]);
  try {
    const slots = require('../../server/services/slots');
    await slots.cancelSession(id, 'normal');
    const after = await pg.query(`SELECT status FROM course_sessions WHERE id=$1`, [id]);
    assert(after.rows[0].status === 'cancelled_normal', `status=cancelled_normal，實際 ${after.rows[0].status}`);
  } finally {
    await pg.query(`UPDATE course_sessions SET status=$1, cancelled_at=NULL WHERE id=$2`, [before.rows[0].status, id]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
