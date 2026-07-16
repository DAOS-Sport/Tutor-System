// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本測試鎖定凍結政策（預約即時確認＋遷移轉正）；改斷言＝改政策。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
// 路徑 C（政策 2026-07 改版）：團報/共班預約不再等待同組確認 ——
// 1) 契約檢查：bookSlot1vN 已自 services/slots 移除；routes/slots.js 不再分流；
//    cron 不再有 pending_group_confirm 自動確認；bootstrap 含一次性遷移。
// 2) 功能檢查：bookSlot1v1 對任何 period（含多家庭共享期）即時 confirmed、槽位轉 booked。
// 3) 遷移檢查：手植 pending_group_confirm session/slot 後執行與 bootstrap 相同的
//    遷移語句 → session 轉 confirmed、有 session 的槽位轉 booked、孤兒槽位釋回 available。
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Client } = require('../../server/node_modules/pg');
const { assert, step } = require('./_lib');
const slots = require('../../server/services/slots');

(async () => {
  step('Path C: 團報預約即時確認（pending_group_confirm 已除役）');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  step('契約：雙方同意流程的程式路徑已全數移除');
  const root = path.join(__dirname, '..', '..');
  const routesSlots = fs.readFileSync(path.join(root, 'server/routes/slots.js'), 'utf8');
  const cronSource = fs.readFileSync(path.join(root, 'server/cron/index.js'), 'utf8');
  const bootstrapSource = fs.readFileSync(path.join(root, 'server/bootstrap/coreSchema.js'), 'utf8');
  assert(typeof slots.bookSlot1vN === 'undefined', 'services/slots 不再輸出 bookSlot1vN');
  assert(typeof slots.bookSlot1v1 === 'function', 'bookSlot1v1 仍存在');
  assert(!routesSlots.includes('bookSlot1vN'), 'routes/slots.js 不再分流到 1vN');
  assert(!/group_confirm_deadline < NOW\(\)/.test(cronSource), 'cron 不再有逾時自動確認排程');
  assert(bootstrapSource.includes(`WHERE status = 'pending_group_confirm'`),
    'bootstrap 含 pending_group_confirm 一次性遷移');

  const cur = await pg.query(
    `SELECT cp.id AS period_id, cp.coach_id, cp.venue_id
       FROM course_periods cp
       JOIN course_period_enrollments cpe ON cpe.course_period_id = cp.id AND cpe.status = 'active'
      WHERE cp.status = 'active' AND cp.coach_id IS NOT NULL
      LIMIT 1`
  );
  if (!cur.rowCount) {
    console.log('  ⚠ 無 active period，僅完成契約檢查');
    await pg.end();
    step('done');
    return;
  }
  const { period_id: periodId, coach_id: coachId, venue_id: venueId } = cur.rows[0];

  let slotId = null;
  let sessionId = null;
  const migSessionIds = [];
  const migSlotIds = [];
  try {
    step('功能：bookSlot1v1 即時 confirmed、槽位 booked');
    slotId = randomUUID();
    await pg.query(
      `INSERT INTO coach_availability_slots (id, coach_id, venue_id, start_at, duration_minutes, status, notes)
       VALUES ($1,$2,$3,NOW() + INTERVAL '200 days',60,'available','E2E path C direct confirm')`,
      [slotId, coachId, venueId]
    );
    const session = await slots.bookSlot1v1(slotId, periodId);
    sessionId = session.id;
    assert(session.status === 'confirmed', `session 即時 confirmed，實際 ${session.status}`);
    const slotRow = await pg.query(`SELECT status, booked_session_id FROM coach_availability_slots WHERE id = $1`, [slotId]);
    assert(slotRow.rows[0].status === 'booked' && slotRow.rows[0].booked_session_id === sessionId,
      '槽位立即 booked 並掛上 session');

    step('遷移：殘留 pending_group_confirm 轉正');
    // 手植一組「舊資料」：pending session＋掛著它的 pending 槽位＋一個孤兒 pending 槽位
    const migSlotBooked = randomUUID();
    const migSlotOrphan = randomUUID();
    migSlotIds.push(migSlotBooked, migSlotOrphan);
    const migSession = await pg.query(
      `INSERT INTO course_sessions (course_period_id, coach_id, scheduled_at, duration_minutes, status)
       VALUES ($1,$2,NOW() + INTERVAL '201 days',60,'pending_group_confirm') RETURNING id`,
      [periodId, coachId]
    );
    migSessionIds.push(migSession.rows[0].id);
    await pg.query(
      `INSERT INTO coach_availability_slots (id, coach_id, venue_id, start_at, duration_minutes, status, booked_session_id, notes)
       VALUES ($1,$2,$3,NOW() + INTERVAL '201 days',60,'pending_group_confirm',$4,'E2E path C migration booked')`,
      [migSlotBooked, coachId, venueId, migSession.rows[0].id]
    );
    await pg.query(
      `INSERT INTO coach_availability_slots (id, coach_id, venue_id, start_at, duration_minutes, status, notes)
       VALUES ($1,$2,$3,NOW() + INTERVAL '202 days',60,'pending_group_confirm','E2E path C migration orphan')`,
      [migSlotOrphan, coachId, venueId]
    );
    // 執行與 bootstrap DDL 完全相同的遷移語句（bootstrap 每次啟動也會跑，冪等）
    await pg.query(`ALTER TABLE course_sessions ADD COLUMN IF NOT EXISTS auto_confirmed_at TIMESTAMPTZ`);
    await pg.query(`
      UPDATE course_sessions
         SET status = 'confirmed', auto_confirmed_at = NOW(), updated_at = NOW()
       WHERE status = 'pending_group_confirm';
      UPDATE coach_availability_slots
         SET status = 'booked'
       WHERE status = 'pending_group_confirm' AND booked_session_id IS NOT NULL;
      UPDATE coach_availability_slots
         SET status = 'available', booked_session_id = NULL
       WHERE status = 'pending_group_confirm' AND booked_session_id IS NULL;
    `);
    const migSessionAfter = await pg.query(
      `SELECT status::text AS status, auto_confirmed_at FROM course_sessions WHERE id = $1`,
      [migSession.rows[0].id]
    );
    assert(migSessionAfter.rows[0].status === 'confirmed' && migSessionAfter.rows[0].auto_confirmed_at,
      `pending session 轉 confirmed 並記 auto_confirmed_at，實際 ${migSessionAfter.rows[0].status}`);
    const migSlots = await pg.query(
      `SELECT id, status::text AS status, booked_session_id FROM coach_availability_slots WHERE id = ANY($1::uuid[])`,
      [migSlotIds]
    );
    const bookedRow = migSlots.rows.find((r) => r.id === migSlotBooked);
    const orphanRow = migSlots.rows.find((r) => r.id === migSlotOrphan);
    assert(bookedRow.status === 'booked' && bookedRow.booked_session_id === migSession.rows[0].id,
      '掛著 session 的 pending 槽位轉 booked');
    assert(orphanRow.status === 'available' && orphanRow.booked_session_id === null,
      '孤兒 pending 槽位釋回 available');
    // 殘留檢查：全庫不應再有 pending_group_confirm
    const leftovers = await pg.query(
      `SELECT (SELECT COUNT(*)::int FROM course_sessions WHERE status = 'pending_group_confirm') AS s,
              (SELECT COUNT(*)::int FROM coach_availability_slots WHERE status = 'pending_group_confirm') AS a`
    );
    assert(leftovers.rows[0].s === 0 && leftovers.rows[0].a === 0, '遷移後全庫無 pending_group_confirm 殘留');

    step('PASS: 即時確認 + 遷移轉正皆符合新政策');
  } finally {
    if (migSlotIds.length) {
      await pg.query(`UPDATE coach_availability_slots SET booked_session_id = NULL WHERE id = ANY($1::uuid[])`, [migSlotIds]).catch(() => {});
    }
    if (slotId) await pg.query(`UPDATE coach_availability_slots SET booked_session_id = NULL WHERE id = $1`, [slotId]).catch(() => {});
    if (migSessionIds.length) await pg.query(`DELETE FROM course_sessions WHERE id = ANY($1::uuid[])`, [migSessionIds]).catch(() => {});
    if (sessionId) await pg.query(`DELETE FROM course_sessions WHERE id = $1`, [sessionId]).catch(() => {});
    if (migSlotIds.length) await pg.query(`DELETE FROM coach_availability_slots WHERE id = ANY($1::uuid[])`, [migSlotIds]).catch(() => {});
    if (slotId) await pg.query(`DELETE FROM coach_availability_slots WHERE id = $1`, [slotId]).catch(() => {});
    await pg.end().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
