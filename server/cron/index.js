/**
 * 定時任務中心
 * 所有 node-cron 排程在此統一管理
 */
const cron = require('node-cron');
const { pool } = require('../models/db');
const line = require('../services/line');
const chatRooms = require('../services/chatRooms');
const evaluations = require('../services/evaluations');

const LIFF_URL = process.env.LIFF_URL || 'https://liff.line.me/-';

function initCronJobs() {
  // ── 每 5 分鐘：補 active period 的 chat_room（防漂移；spec F-S09）──
  // 任何「直接 UPDATE course_periods.status='active'」或 race condition 都會被這個排程兜底。
  cron.schedule('*/5 * * * *', async () => {
    try {
      const n = await chatRooms.backfillRoomsForActivePeriods();
      if (n > 0) console.log(`[Cron/chat] backfilled ${n} chat_rooms for active periods`);
    } catch (err) {
      console.warn('[Cron/chat] backfill failed:', err.message);
    }
  });


  // ── 每分鐘：1vN 槽位逾時自動確認 ──────────
  cron.schedule('* * * * *', async () => {
    const res = await pool.query(
      `SELECT cs.id, cp.venue_id FROM course_sessions cs
       JOIN course_periods cp ON cs.course_period_id = cp.id
       WHERE cs.status = 'pending_group_confirm'
         AND cs.group_confirm_deadline < NOW()`
    );
    for (const row of res.rows) {
      await pool.query(
        `UPDATE course_sessions SET status = 'confirmed', auto_confirmed_at = NOW() WHERE id = $1`,
        [row.id]
      );
      await pool.query(
        `UPDATE coach_availability_slots SET status = 'booked' WHERE booked_session_id = $1`,
        [row.id]
      );
      // TODO: 發送全組確認 Flex Message
    }
  });

  // ── 每小時：上課前 1 小時提醒 ────────────
  cron.schedule('0 * * * *', async () => {
    const targetTime = new Date(Date.now() + 60 * 60 * 1000);
    const start = new Date(targetTime); start.setMinutes(0, 0, 0);
    const end   = new Date(targetTime); end.setMinutes(59, 59, 999);
    const res = await pool.query(
      `SELECT cs.id, cs.scheduled_at, cp.coach_id, cp.venue_id, cp.id AS period_id
       FROM course_sessions cs
       JOIN course_periods cp ON cs.course_period_id = cp.id
       WHERE cs.status = 'confirmed'
         AND cs.scheduled_at BETWEEN $1 AND $2`,
      [start.toISOString(), end.toISOString()]
    );
    for (const row of res.rows) {
      // TODO: 查詢教練與學員 line_uid，發送提醒 Flex Message
    }
  });

  // ── 每天 09:00：堂數快到期提醒 ───────────
  cron.schedule('0 9 * * *', async () => {
    const res = await pool.query(
      `SELECT cp.id, cp.venue_id, cp.coach_id,
              (cp.total_sessions - cp.used_sessions) AS remaining
       FROM course_periods cp
       WHERE cp.status = 'active'
         AND cp.expires_at = CURRENT_DATE + (
           SELECT value::INTEGER FROM system_settings WHERE key = 'expiry_notify_days'
         )`
    );
    for (const row of res.rows) {
      // TODO: 發送到期提醒 Flex Message 給家長
    }
  });

  // ── 每天 10:00：期末評鑑邀請 + 7 天提醒 ────────
  cron.schedule('0 10 * * *', async () => {
    try {
      // (a) 課程期已修完且尚未建立 invitation → 為每位家長建立 1 筆並推播
      const due = await pool.query(
        `SELECT cp.id, cp.venue_id, co.name AS coach_name
           FROM course_periods cp JOIN coaches co ON co.id = cp.coach_id
          WHERE cp.status = 'active'
            AND cp.used_sessions >= cp.total_sessions
            AND NOT EXISTS (SELECT 1 FROM course_evaluations ce WHERE ce.course_period_id = cp.id)`
      );
      for (const row of due.rows) {
        const created = await evaluations.ensureInvitation(row.id);
        for (const inv of created) {
          const parent = await pool.query(`SELECT line_uid FROM parents WHERE id = $1`, [inv.parent_id]);
          const uid = parent.rows[0]?.line_uid;
          if (!uid) continue;
          const msg = line.templates.evaluationInvite({
            coachName: row.coach_name,
            liffUrl: `${LIFF_URL}#/evaluation/${inv.id}`,
          });
          try { await line.pushMessage(uid, msg, row.venue_id); }
          catch (e) { console.warn('[Cron/eval] push invite failed:', e.message); }
        }
      }

      // (b) 邀請超過 7 天未填且未提醒 → 推一次提醒並標記
      const remind = await evaluations.listInvitesForReminder();
      for (const r of remind) {
        const parent = await pool.query(`SELECT line_uid FROM parents WHERE id = $1`, [r.parent_id]);
        const coach = await pool.query(`SELECT name FROM coaches WHERE id = $1`, [r.coach_id]);
        const uid = parent.rows[0]?.line_uid;
        if (!uid) { await evaluations.markReminderSent(r.id); continue; }
        const msg = line.templates.evaluationInvite({
          coachName: coach.rows[0]?.name || '',
          liffUrl: `${LIFF_URL}#/evaluation/${r.id}`,
        });
        try {
          await line.pushMessage(uid, msg, r.venue_id);
          await evaluations.markReminderSent(r.id);
        } catch (e) {
          console.warn('[Cron/eval] push reminder failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('[Cron/eval] failed:', e.message);
    }
  });

  console.log('[Cron] All cron jobs initialized');
}

module.exports = { initCronJobs };
