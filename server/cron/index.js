/**
 * 定時任務中心
 * 所有 node-cron 排程在此統一管理
 */
const cron = require('node-cron');
const { pool } = require('../models/db');
const line = require('../services/line');

function initCronJobs() {
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

  // ── 每天 10:00：期末評鑑邀請 ─────────────
  cron.schedule('0 10 * * *', async () => {
    // 找今天完成最後一堂課的課程期
    const res = await pool.query(
      `SELECT cp.id, cp.venue_id
       FROM course_periods cp
       WHERE cp.status = 'active'
         AND cp.used_sessions >= cp.total_sessions
         AND NOT EXISTS (
           SELECT 1 FROM course_evaluations ce WHERE ce.course_period_id = cp.id
         )`
    );
    for (const row of res.rows) {
      // TODO: 建立 evaluation 記錄並發送邀請 Flex Message
    }
  });

  // ── 每天 10:00：期末評鑑 7 天提醒（同任務繼續）
  cron.schedule('0 10 * * *', async () => {
    const res = await pool.query(
      `SELECT ce.id, ce.parent_id, cp.venue_id
       FROM course_evaluations ce
       JOIN course_periods cp ON ce.course_period_id = cp.id
       WHERE ce.submitted_at IS NULL
         AND ce.reminder_sent_at IS NULL
         AND ce.invited_at < NOW() - INTERVAL '7 days'`
    );
    for (const row of res.rows) {
      // TODO: 發送提醒 Flex Message 並更新 reminder_sent_at
    }
  });

  console.log('[Cron] All cron jobs initialized');
}

module.exports = { initCronJobs };
