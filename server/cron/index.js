/**
 * 定時任務中心
 * 所有 node-cron 排程在此統一管理
 */
const cron = require('node-cron');
const { pool } = require('../models/db');
const line = require('../services/line');
const chatRooms = require('../services/chatRooms');
const evaluations = require('../services/evaluations');
const ragicAdmin = require('../services/ragicAdmin');

// 對家長推播的 LIFF base URL；新版用 LIFF_URL_PARENT，舊版 LIFF_URL 為 fallback
const LIFF_URL = process.env.LIFF_URL_PARENT || process.env.LIFF_URL || 'https://liff.line.me/-';

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

  // ── 每小時：上課前 1 小時提醒 (F-S05) ────
  // 抓未來 60–120 分鐘內的 confirmed sessions，推給教練 + 該堂所有學員之家長。
  // notification_log UNIQUE(kind,ref_id,recipient_uid) 確保不重複推。
  cron.schedule('0 * * * *', async () => {
    try {
      const start = new Date(Date.now() + 60 * 60 * 1000);
      const end   = new Date(Date.now() + 120 * 60 * 1000);
      const res = await pool.query(
        `SELECT cs.id, cs.scheduled_at, cp.venue_id, cp.id AS period_id, cp.course_type,
                co.name AS coach_name, co.line_uid AS coach_uid, v.name AS venue_name
           FROM course_sessions cs
           JOIN course_periods cp ON cs.course_period_id = cp.id
           JOIN coaches co ON co.id = cp.coach_id
           JOIN venues v ON v.id = cp.venue_id
          WHERE cs.status IN ('confirmed','pending_group_confirm')
            AND cs.scheduled_at BETWEEN $1 AND $2`,
        [start.toISOString(), end.toISOString()]
      );
      for (const s of res.rows) {
        // 取家長 line_uid（透過該 period 的 enrollments → students → parent）
        const ps = await pool.query(
          `SELECT DISTINCT p.line_uid FROM course_period_enrollments cpe
             JOIN students st ON st.id = cpe.student_id
             JOIN parents p ON p.id = st.parent_id
            WHERE cpe.course_period_id = $1 AND cpe.status='active' AND p.line_uid IS NOT NULL`,
          [s.period_id]
        );
        const targets = [
          ...(s.coach_uid ? [{ uid: s.coach_uid, role: 'coach' }] : []),
          ...ps.rows.map((r) => ({ uid: r.line_uid, role: 'parent' })),
        ];
        const startStr = new Date(s.scheduled_at).toLocaleString('zh-TW',
          { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        for (const t of targets) {
          // claim send-right first：插入成功才推播，杜絕並發雙發
          const claim = await pool.query(
            `INSERT INTO notification_log (kind, ref_id, recipient_uid)
             VALUES ('session_reminder_1h', $1, $2)
             ON CONFLICT DO NOTHING RETURNING id`,
            [s.id, t.uid]
          );
          if (!claim.rowCount) continue;
          const msg = line.templates.sessionReminder({
            coachName: s.coach_name, venueName: s.venue_name,
            scheduledAt: startStr, role: t.role,
          });
          try {
            await line.pushMessage(t.uid, msg, s.venue_id);
          } catch (e) {
            console.warn('[Cron/session-reminder] push failed:', e.message);
            // push 失敗 → 釋放 claim 讓下次重試
            await pool.query(`DELETE FROM notification_log WHERE id = $1`, [claim.rows[0].id])
              .catch(() => {});
          }
        }
      }
    } catch (e) { console.warn('[Cron/session-reminder] failed:', e.message); }
  });

  // ── 每天 09:00：堂數快到期提醒 (F-S05) ────
  cron.schedule('0 9 * * *', async () => {
    try {
      const r = await pool.query(
        `SELECT cp.id, cp.venue_id, cp.expires_at, cp.course_type,
                (cp.total_sessions - cp.used_sessions) AS remaining,
                co.name AS coach_name
           FROM course_periods cp
           JOIN coaches co ON co.id = cp.coach_id
          WHERE cp.status = 'active'
            AND cp.expires_at = CURRENT_DATE + (
              SELECT COALESCE((SELECT value::INTEGER FROM admin_settings WHERE key='expiry_notice_days'), 60)
            )`
      );
      for (const cp of r.rows) {
        const ps = await pool.query(
          `SELECT DISTINCT p.line_uid FROM course_period_enrollments cpe
             JOIN students st ON st.id = cpe.student_id
             JOIN parents p ON p.id = st.parent_id
            WHERE cpe.course_period_id = $1 AND cpe.status='active' AND p.line_uid IS NOT NULL`,
          [cp.id]
        );
        for (const row of ps.rows) {
          const claim = await pool.query(
            `INSERT INTO notification_log (kind, ref_id, recipient_uid)
             VALUES ('expiry_reminder', $1, $2)
             ON CONFLICT DO NOTHING RETURNING id`,
            [cp.id, row.line_uid]
          );
          if (!claim.rowCount) continue;
          const msg = line.templates.expiryReminder({
            coachName: cp.coach_name, remainingSessions: cp.remaining,
            expiresAt: new Date(cp.expires_at).toISOString().slice(0, 10),
            liffUrl: `${LIFF_URL}/my-courses`,
          });
          try { await line.pushMessage(row.line_uid, msg, cp.venue_id); }
          catch (e) {
            console.warn('[Cron/expiry] push failed:', e.message);
            await pool.query(`DELETE FROM notification_log WHERE id = $1`, [claim.rows[0].id])
              .catch(() => {});
          }
        }
      }
    } catch (e) { console.warn('[Cron/expiry] failed:', e.message); }
  });

  // ── 每天 09:30：MGM 體驗課當日提醒 (F-S10) ────
  // 抓今天即將上 trial 的 referral_records（status=trial_paid 且該 enrollment 對應 session 在今天）
  // → 推播給推薦方家長，提醒簽到後可獲獎勵。
  cron.schedule('30 9 * * *', async () => {
    try {
      const r = await pool.query(
        `SELECT rr.id, rr.referrer_parent_id, rp.line_uid AS referrer_uid,
                referee.name AS referee_name, cp.venue_id
           FROM referral_records rr
           JOIN parents rp ON rp.id = rr.referrer_parent_id
           LEFT JOIN parents referee ON referee.id = rr.referee_parent_id
           LEFT JOIN admin_enrollments ae ON ae.id = rr.experience_enrollment_id
           LEFT JOIN course_periods cp ON cp.coach_id = rr.coach_id AND cp.venue_id = ae.venue_id
          WHERE rr.status = 'trial_paid' AND rp.line_uid IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM course_sessions cs2
               WHERE cs2.course_period_id = cp.id
                 AND cs2.scheduled_at::date = CURRENT_DATE
            )
          LIMIT 100`
      );
      for (const row of r.rows) {
        const claim = await pool.query(
          `INSERT INTO notification_log (kind, ref_id, recipient_uid)
           VALUES ('mgm_trial_today', $1, $2)
           ON CONFLICT DO NOTHING RETURNING id`,
          [row.id, row.referrer_uid]
        );
        if (!claim.rowCount) continue;
        const msg = line.templates.mgmTrialTodayReminder({
          refereeName: row.referee_name || '好友',
          liffUrl: `${LIFF_URL}/referral`,
        });
        try { await line.pushMessage(row.referrer_uid, msg, row.venue_id || 'B'); }
        catch (e) {
          console.warn('[Cron/mgm-trial] push failed:', e.message);
          await pool.query(`DELETE FROM notification_log WHERE id = $1`, [claim.rows[0].id])
            .catch(() => {});
        }
      }
    } catch (e) { console.warn('[Cron/mgm-trial] failed:', e.message); }
  });

  // ── 每小時 :05：期末評鑑邀請 + 7 天提醒 ────────
  // 不限定 10:00，避免下午/晚上才上完課當天的期別錯過觸發。
  // 觸發條件改為「最後一堂的最新點名時間在最近 24 小時內，且尚未建立
  // 該家長的 invitation」；ensureInvitation() 之 ON CONFLICT 確保冪等。
  cron.schedule('5 * * * *', async () => {
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
                 AND cr.checked_in_at >= NOW() - INTERVAL '25 hours'
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
            liffUrl: `${LIFF_URL}/evaluation/${inv.id}`,
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
          liffUrl: `${LIFF_URL}/evaluation/${r.id}`,
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

  // ── 每 10 分鐘：Ragic H01 / H05 同步（Task #53 — 從 GET 移走的阻塞 sync）──
  // 後台任何 GET 列表只純讀 DB；資料新鮮度由本 cron 維護，外加 GET 時 fire-and-forget
  // (kickoffSync*Async)，下一次 GET 就能拿到最新。
  cron.schedule('*/10 * * * *', async () => {
    if (!ragicAdmin.ragicEnabled()) return;
    try {
      // Task #91：教練資料已合併進員工帳號（H01 員工 API 就涵蓋姓名 / 手機 / 在職），
      // 不再單獨同步 coaches；教練特有欄位（簡介 / 專長 / 介紹圖）由後台手動編輯。
      const [s, v] = await Promise.allSettled([
        ragicAdmin.syncStaffFromRagic(),
        ragicAdmin.syncVenuesFromRagic(),
      ]);
      const tag = (r) => (r.status === 'fulfilled' ? `ok(${r.value.synced ?? 0})` : `err(${r.reason?.message || 'x'})`);
      console.log(`[Cron/Ragic] staff=${tag(s)} venues=${tag(v)}`);
    } catch (e) {
      console.warn('[Cron/Ragic] failed:', e.message);
    }
  });

  console.log('[Cron] All cron jobs initialized');
}

module.exports = { initCronJobs };
