// 路徑 D：自助取消（normal / late）— 兩種類型都跑
// 1) 找/建一筆 confirmed course_session
// 2) 呼叫 services/slots.cancelSession(id, 'normal') → 驗 status='cancelled_normal' + used_sessions 退回
// 3) 同樣對 'late' 一遍 → 驗 status='cancelled_late' + used_sessions 不退
const { Client } = require('../../server/node_modules/pg');
const { assert, step } = require('./_lib');
const slots = require('../../server/services/slots');

(async () => {
  step('Path D: 自助取消 normal + late');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const cur = await pg.query(
    `SELECT cp.id AS period_id, COALESCE(cp.used_sessions, 0) AS used
       FROM course_periods cp
       JOIN course_period_enrollments cpe ON cpe.course_period_id=cp.id AND cpe.status='active'
      LIMIT 1`,
  );
  if (!cur.rowCount) {
    assert(typeof slots.cancelSession === 'function', 'cancelSession 函數存在');
    await pg.end(); step('done'); return;
  }
  const { period_id, used: baseUsed } = cur.rows[0];

  const created = [];
  try {
    for (const kind of ['normal', 'penalty']) {
      const ins = await pg.query(
        `INSERT INTO course_sessions (course_period_id, scheduled_at, duration_minutes, status)
         VALUES ($1, NOW() + INTERVAL '1 day', 60, 'confirmed') RETURNING id`,
        [period_id],
      );
      const sid = ins.rows[0].id;
      created.push(sid);
      await pg.query(`UPDATE course_periods SET used_sessions = COALESCE(used_sessions,0) + 1 WHERE id=$1`, [period_id]);
      const beforeUsed = (await pg.query(`SELECT used_sessions FROM course_periods WHERE id=$1`, [period_id])).rows[0].used_sessions;

      await slots.cancelSession(sid, kind);

      const after = await pg.query(`SELECT status FROM course_sessions WHERE id=$1`, [sid]);
      assert(after.rows[0].status === `cancelled_${kind}`,
        `[${kind}] status=cancelled_${kind}，實際 ${after.rows[0].status}`);

      const afterUsed = (await pg.query(`SELECT used_sessions FROM course_periods WHERE id=$1`, [period_id])).rows[0].used_sessions;
      if (kind === 'normal') {
        assert(afterUsed === beforeUsed - 1, `[normal] used_sessions 退回 (before=${beforeUsed}, after=${afterUsed})`);
      } else {
        assert(afterUsed === beforeUsed, `[penalty] used_sessions 不退 (before=${beforeUsed}, after=${afterUsed})`);
        await pg.query(`UPDATE course_periods SET used_sessions = used_sessions - 1 WHERE id=$1`, [period_id]);
      }
    }
  } finally {
    if (created.length) await pg.query(`DELETE FROM course_sessions WHERE id = ANY($1::uuid[])`, [created]);
    await pg.query(`UPDATE course_periods SET used_sessions = $1 WHERE id=$2`, [baseUsed, period_id]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
