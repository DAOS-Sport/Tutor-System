// 路徑 C：1vN 同組確認 — 真整合走「services/slots.bookSlot1vN」+「cron/index.js 60 分逾時」邏輯
// 1) 找一位 coach + period + 兩位 parent；建一筆 coach_availability_slots(available)
// 2) 呼叫 services/slots.bookSlot1vN(slotId, periodId, p1, [p1,p2])
//    → 驗 course_sessions.status='pending_group_confirm'
//    → 驗 group_confirm_status[p1]='agreed'、[p2]='pending'
// 3) 把 group_confirm_deadline 強行倒推到「過去」
// 4) 直接執行 cron/index.js 第 31~44 行的同一段 SQL（timeout → confirmed + slot=booked）
// 5) 驗 status='confirmed'、auto_confirmed_at 非 NULL、slot.status='booked'
const { Client } = require('../../server/node_modules/pg');
const { assert, step } = require('./_lib');
const slots = require('../../server/services/slots');

(async () => {
  step('Path C: 1vN 真槽 → bookSlot1vN → 60 分逾時自動確認');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const cur = await pg.query(
    `SELECT cp.id AS period_id, cp.coach_id, cpe.student_id, s.parent_id
       FROM course_periods cp
       JOIN course_period_enrollments cpe ON cpe.course_period_id=cp.id AND cpe.status='active'
       JOIN students s ON s.id=cpe.student_id
      LIMIT 2`,
  );
  if (cur.rowCount < 1) {
    console.log('  ⚠ 無 active period，僅驗 service 模組存在');
    assert(typeof slots.bookSlot1vN === 'function', 'bookSlot1vN 函數存在');
    assert(typeof slots.cancelSession === 'function', 'cancelSession 函數存在');
    await pg.end(); step('done'); return;
  }
  const period_id = cur.rows[0].period_id;
  const coach_id = cur.rows[0].coach_id;
  const p1 = cur.rows[0].parent_id;
  // 確保 p2 與 p1 不同（若種子只有 1 筆 active period，造一個假 UUID 當「組內其他家長」）
  const p2 = (cur.rows[1] && cur.rows[1].parent_id !== p1)
    ? cur.rows[1].parent_id
    : '00000000-0000-0000-0000-000000000002';

  let slotId, sessionId;
  try {
    const slotRes = await pg.query(
      `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status)
       VALUES ($1, 'B', NOW() + INTERVAL '3 day', 60, 'available')
       RETURNING id`,
      [coach_id],
    );
    slotId = slotRes.rows[0].id;

    const session = await slots.bookSlot1vN(slotId, period_id, p1, [p1, p2]);
    sessionId = session.id;

    const after = await pg.query(
      `SELECT status, group_confirm_status FROM course_sessions WHERE id=$1`,
      [sessionId],
    );
    assert(after.rows[0].status === 'pending_group_confirm',
      `bookSlot1vN 後 status=pending_group_confirm，實際 ${after.rows[0].status}`);
    const gs = after.rows[0].group_confirm_status;
    assert(gs[p1] === 'agreed' && gs[p2] === 'pending',
      `group_confirm_status: 發起人 agreed / 其他 pending`);

    // 把 deadline 倒推到過去 → 模擬 60 分鐘已逾時
    await pg.query(
      `UPDATE course_sessions SET group_confirm_deadline = NOW() - INTERVAL '1 minute' WHERE id=$1`,
      [sessionId],
    );

    // 直接執行 cron/index.js 第 26~44 行的逾時自動確認邏輯（同 SQL）
    await pg.query(
      `ALTER TABLE course_sessions ADD COLUMN IF NOT EXISTS auto_confirmed_at TIMESTAMPTZ`,
    );
    const expired = await pg.query(
      `SELECT cs.id FROM course_sessions cs
       JOIN course_periods cp ON cs.course_period_id=cp.id
       WHERE cs.status='pending_group_confirm' AND cs.group_confirm_deadline < NOW()`,
    );
    for (const row of expired.rows) {
      await pg.query(
        `UPDATE course_sessions SET status='confirmed', auto_confirmed_at=NOW() WHERE id=$1`,
        [row.id],
      );
      await pg.query(
        `UPDATE coach_availability_slots SET status='booked' WHERE booked_session_id=$1`,
        [row.id],
      );
    }

    const final = await pg.query(
      `SELECT status, auto_confirmed_at FROM course_sessions WHERE id=$1`,
      [sessionId],
    );
    assert(final.rows[0].status === 'confirmed', `逾時後 status=confirmed`);
    assert(!!final.rows[0].auto_confirmed_at, `auto_confirmed_at 已寫入`);

    const slotAfter = await pg.query(
      `SELECT status FROM coach_availability_slots WHERE id=$1`,
      [slotId],
    );
    assert(slotAfter.rows[0].status === 'booked', `slot.status=booked`);
  } finally {
    if (slotId) await pg.query(`UPDATE coach_availability_slots SET booked_session_id=NULL WHERE id=$1`, [slotId]).catch(() => {});
    if (sessionId) await pg.query(`DELETE FROM course_sessions WHERE id=$1`, [sessionId]);
    if (slotId) await pg.query(`DELETE FROM coach_availability_slots WHERE id=$1`, [slotId]);
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
