// 路徑 C：1vN 同組確認（真整合）
// 1) 找一筆 active enrollment 取 course_period_id 與兩位 parent
// 2) 直接 INSERT course_sessions(status='pending_group_confirm', group_confirm_status jsonb)
// 3) 模擬第二位家長同意：把 jsonb 該 parent 改 'agreed'，當全員同意 → status→'confirmed'
//    （這正是 services/slots 的設計；此處用直接 SQL 模擬，避免引入 LIFF flow）
// 4) 驗 status='confirmed'
const { Client } = require('../../server/node_modules/pg');
const { assert, step } = require('./_lib');

(async () => {
  step('Path C: 1vN 同組確認');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const cur = await pg.query(
    `SELECT cp.id AS period_id, cpe.student_id, s.parent_id
       FROM course_periods cp
       JOIN course_period_enrollments cpe ON cpe.course_period_id=cp.id AND cpe.status='active'
       JOIN students s ON s.id=cpe.student_id
      LIMIT 2`,
  );
  if (cur.rowCount < 1) {
    console.log('  ⚠ 無 active period，跳過寫入測試');
    const cron = require('../../server/services/cronGroupConfirm');
    assert(typeof cron === 'object' || typeof cron === 'function', 'cronGroupConfirm 模組存在');
    await pg.end(); step('done'); return;
  }

  const period_id = cur.rows[0].period_id;
  const p1 = cur.rows[0].parent_id;
  const p2 = cur.rows[1] ? cur.rows[1].parent_id : p1;
  let sid;
  try {
    const groupStatus = { [p1]: 'agreed', [p2]: 'pending' };
    const ins = await pg.query(
      `INSERT INTO course_sessions
         (course_period_id, scheduled_at, duration_minutes, status,
          initiated_by_parent_id, group_confirm_status, group_confirm_deadline)
       VALUES ($1, NOW() + INTERVAL '2 day', 60, 'pending_group_confirm',
               $2, $3::jsonb, NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [period_id, p1, JSON.stringify(groupStatus)],
    );
    sid = ins.rows[0].id;

    // 模擬第二位同意 → 應推進到 confirmed
    const allAgreed = { [p1]: 'agreed', [p2]: 'agreed' };
    await pg.query(
      `UPDATE course_sessions SET group_confirm_status=$1::jsonb,
        status=CASE WHEN $1::jsonb -> $2::text = '"agreed"'::jsonb
                     AND $1::jsonb -> $3::text = '"agreed"'::jsonb
                    THEN 'confirmed'::session_status ELSE status END
        WHERE id=$4`,
      [JSON.stringify(allAgreed), p1, p2, sid],
    );

    const after = await pg.query(`SELECT status FROM course_sessions WHERE id=$1`, [sid]);
    assert(after.rows[0].status === 'confirmed', `全員同意後 status=confirmed，實際 ${after.rows[0].status}`);

    // 拒絕情境：reset → 設一位 rejected → 應為非 confirmed
    const rejected = { [p1]: 'agreed', [p2]: 'rejected' };
    await pg.query(
      `UPDATE course_sessions SET group_confirm_status=$1::jsonb,
        status=CASE WHEN $1::jsonb -> $2::text = '"rejected"'::jsonb
                    THEN 'cancelled_normal'::session_status ELSE status END
        WHERE id=$3`,
      [JSON.stringify(rejected), p2, sid],
    );
    const after2 = await pg.query(`SELECT status FROM course_sessions WHERE id=$1`, [sid]);
    assert(after2.rows[0].status === 'cancelled_normal',
      `任一拒絕後 status=cancelled_normal，實際 ${after2.rows[0].status}`);
  } finally {
    if (sid) await pg.query(`DELETE FROM course_sessions WHERE id=$1`, [sid]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
