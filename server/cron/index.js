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
      // (a) F-S12 觸發：「最後一堂的點名日 = 今天」且尚未建立 invitation。
      // 以 checkin_records 的時間為準（不依賴 used_sessions 計數），符合
      // 「最後一堂上完點名後當日寄發」規格。
      const due = await pool.query(
        `WITH last_sess AS (
           SELECT DISTINCT ON (cs.course_period_id)
                  cs.course_period_id, cs.id AS session_id, cs.scheduled_at
             FROM course_sessions cs
            ORDER BY cs.course_period_id, cs.scheduled_at DESC
         )
         SELECT cp.id, cp.venue_id, co.name AS coach_name
           FROM course_periods cp
           JOIN coaches co ON co.id = cp.coach_id
           JOIN last_sess ls ON ls.course_period_id = cp.id
          WHERE cp.status IN ('active','completed')
            AND EXISTS (
              SELECT 1 FROM checkin_records cr
               WHERE cr.course_session_id = ls.session_id
                 AND cr.checked_in_at::date = CURRENT_DATE
            )
            -- 不再以「period 已有任一 invitation」為前置過濾，
            -- 改全交由 ensureInvitation() 之 ON CONFLICT 保證冪等，
            -- 避免之前部分推播失敗導致同期間其他家長永遠補不到 invitation。`
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

  // ── 每天 10:30：考核門檻不達標偵測 → 通知主管 (F-A09) ────────
  // 同月、同教練、同 metric 不重複（資料庫 UNIQUE 兜底）；推 LINE 給管理層 admin_users.line_uid。
  cron.schedule('30 10 * * *', async () => {
    try {
      const created = await evaluations.detectBelowThreshold();
      if (created.length) {
        console.warn(`[Cron/eval-threshold] flagged ${created.length} below-threshold metric(s)`);
      }
      const pending = await evaluations.listPendingAlerts();
      if (!pending.length) return;
      // 收件人：admin / manager 且設定了 line_uid；每位主管帶自己的 venue_id
      // （pushMessage 需要 venueId 解析 channel token；無 venue 的 admin 用任一啟用場館兜底）。
      const mgrs = await pool.query(
        `SELECT line_uid, venue_id FROM admin_users
          WHERE role IN ('admin','manager') AND line_uid IS NOT NULL`
      );
      let fallbackVenue = null;
      if (mgrs.rows.some((m) => !m.venue_id)) {
        const v = await pool.query(`SELECT id FROM venues WHERE is_active = TRUE ORDER BY id LIMIT 1`);
        fallbackVenue = v.rows[0]?.id || null;
      }
      const targets = mgrs.rows
        .map((m) => ({ uid: m.line_uid, venueId: m.venue_id || fallbackVenue }))
        .filter((t) => t.uid && t.venueId);
      const adminUrl = (process.env.ADMIN_URL || '').replace(/\/$/, '');
      const dashboardUrl = adminUrl ? `${adminUrl}/admin/coach-eval` : 'https://example.com/admin/coach-eval';
      for (const a of pending) {
        const text =
          `【教練考核警示】\n${a.coach_name}：${a.metric}\n` +
          `近 ${a.window_months} 個月觀察值 ${a.observed_value ?? '—'}（門檻 ${a.min_value}）\n` +
          `${dashboardUrl}`;
        let delivered = 0;
        for (const t of targets) {
          try {
            await line.pushMessage(t.uid, [{ type: 'text', text }], t.venueId);
            delivered += 1;
          } catch (e) {
            console.warn('[Cron/eval-threshold] push failed:', e.message);
          }
        }
        // 至少一位主管成功收到才標記，避免永久遺失通知（下次 cron 會重試）。
        if (delivered > 0) {
          await evaluations.markAlertNotified(a.id);
        } else {
          console.warn(`[Cron/eval-threshold] alert ${a.id} undelivered; will retry next run`);
        }
      }
    } catch (e) {
      console.warn('[Cron/eval-threshold] failed:', e.message);
    }
  });

  console.log('[Cron] All cron jobs initialized');
}

module.exports = { initCronJobs };
