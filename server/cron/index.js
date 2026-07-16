// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔凍結範圍：不得復活「pending_group_confirm 逾時自動確認」排程（其餘 cron 不在凍結範圍）。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
/**
 * 定時任務中心
 * 所有 node-cron 排程在此統一管理
 */
const cron = require('node-cron');
const { formatTaipeiDateTime, formatPlainDate } = require('../utils/dateTime');
const scheduleTaipei = (expression, task) => cron.schedule(expression, task, { timezone: 'Asia/Taipei' });
const { pool } = require('../models/db');
const line = require('../services/line');
const chatRooms = require('../services/chatRooms');
const evaluations = require('../services/evaluations');
const ragicAdmin = require('../services/ragicAdmin');
const { processRagicSyncOutbox } = require('../services/ragicSyncOutbox');
const { verifyRagicZ01UidSchemaFreshness } = require('../services/ragicSchemaFreshness');
const { STABILITY_FLAGS } = require('../config/ragicSchema');
const { applyDueScheduledCourseTypeChanges } = require('../services/courseTypeSchedule');

// 對家長推播的 LIFF base URL；新版用 LIFF_URL_PARENT，舊版 LIFF_URL 為 fallback
const LIFF_URL = process.env.LIFF_URL_PARENT || process.env.LIFF_URL || 'https://liff.line.me/-';

function initCronJobs() {
  const ragicConfigured = ragicAdmin.ragicEnabled();
  const ragicZ01Configured = ragicConfigured && Boolean(process.env.RAGIC_FORM_Z01);
  const outboxFlagEnabled = STABILITY_FLAGS.RAGIC_PARENT_OUTBOX;
  console.log(JSON.stringify({
    event: 'ragic_parent_outbox_startup',
    ragic_configured: ragicConfigured,
    z01_configured: ragicZ01Configured,
    flag_enabled: outboxFlagEnabled,
    enabled: ragicZ01Configured && outboxFlagEnabled,
    disabled_reason: !ragicConfigured
      ? 'RAGIC_NOT_CONFIGURED'
      : (!ragicZ01Configured
        ? 'RAGIC_Z01_NOT_CONFIGURED'
        : (!outboxFlagEnabled ? 'RAGIC_PARENT_OUTBOX_DISABLED' : null)),
  }));
  // Startup/deployment proof. Failure blocks only the remote UID worker; local
  // parent auth and already-committed local claims remain available.
  if (ragicZ01Configured) {
    verifyRagicZ01UidSchemaFreshness()
      .then((e) => console.log(`[Cron/RagicSchema] verified=${e.verified} hash=${e.response_hash.slice(0, 12)} fetched=${e.fetched_at.toISOString()}`))
      .catch((err) => console.warn('[Cron/RagicSchema] RAGIC_SCHEMA_NOT_VERIFIED:', err.code || err.message));
  }
  // Periodic live def=1 renewal. The 5-minute cadence remains below the default
  // 15-minute TTL, so a missed/failed renewal naturally makes the worker stale.
  scheduleTaipei('*/5 * * * *', async () => {
    if (!ragicAdmin.ragicEnabled() || !process.env.RAGIC_FORM_Z01) return;
    try {
      const evidence = await verifyRagicZ01UidSchemaFreshness();
      if (!evidence.verified) console.warn('[Cron/RagicSchema] schema mismatch; UID writes remain paused');
    } catch (err) {
      console.warn('[Cron/RagicSchema] verification failed; UID writes remain paused:', err.code || err.message);
    }
  });

  // Local-first Z03 claims commit before Ragic. This worker is the only path
  // that writes the claimed LINE UID back; it never resolves or creates an
  // identity, and failed writes remain retryable/blocked in the outbox.
  scheduleTaipei('*/5 * * * *', async () => {
    if (!ragicAdmin.ragicEnabled() || !process.env.RAGIC_FORM_Z01 || !STABILITY_FLAGS.RAGIC_PARENT_OUTBOX) return;
    try {
      const r = await processRagicSyncOutbox({ limit: 20 });
      if (r.processed) {
        console.log(`[Cron/RagicOutbox] processed=${r.processed} synced=${r.synced} retryable=${r.retryable} blocked=${r.blocked}`);
      }
    } catch (err) {
      console.warn('[Cron/RagicOutbox] failed:', err.code || err.message);
    }
  });

  // ── 每 5 分鐘：補 active period 的 chat_room（防漂移；spec F-S09）──
  // 任何「直接 UPDATE course_periods.status='active'」或 race condition 都會被這個排程兜底。
  scheduleTaipei('*/5 * * * *', async () => {
    try {
      const n = await chatRooms.backfillRoomsForActivePeriods();
      if (n > 0) console.log(`[Cron/chat] backfilled ${n} chat_rooms for active periods`);
    } catch (err) {
      console.warn('[Cron/chat] backfill failed:', err.message);
    }
  });


  // （已移除）1vN 槽位逾時自動確認 cron：團報預約不再產生 pending_group_confirm，
  // 舊 pending 資料由 bootstrap/coreSchema.js 的冪等遷移一次轉正。

  // ── 每小時：上課前 1 小時提醒 (F-S05) ────
  // 抓未來 60–120 分鐘內的 confirmed sessions，推給教練 + 該堂所有學員之家長。
  // notification_log UNIQUE(kind,ref_id,recipient_uid) 確保不重複推。
  scheduleTaipei('0 * * * *', async () => {
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
        const startStr = formatTaipeiDateTime(s.scheduled_at);
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
  scheduleTaipei('0 9 * * *', async () => {
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
            expiresAt: formatPlainDate(cp.expires_at),
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
  scheduleTaipei('30 9 * * *', async () => {
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
  scheduleTaipei('5 * * * *', async () => {
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
                 AND cr.attendance_status = 'ATTENDED'
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
  scheduleTaipei('30 10 * * *', async () => {
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
  // 刻意循序（非 Promise.allSettled）：兩者都會走全量 Ragic 查詢 + freshness canary
  // 重試，同時對 Ragic 打開兩條連線只會互相拖慢、更容易撞 timeout。比照
  // routes/admin/ragicStatus.js「同步全部」既有的循序設計（見該檔案註解），
  // 讓「同一時間對 Ragic 帳號只有一個 in-flight 請求」這條規則在 cron 這邊也成立。
  scheduleTaipei('*/10 * * * *', async () => {
    if (!ragicAdmin.ragicEnabled()) return;
    // Task #91：教練資料已合併進員工帳號（H01 員工 API 就涵蓋姓名 / 手機 / 在職），
    // 不再單獨同步 coaches；教練特有欄位（簡介 / 專長 / 介紹圖）由後台手動編輯。
    let sTag = 'skipped';
    try {
      const s = await ragicAdmin.syncStaffFromRagic();
      sTag = `ok(${s.synced ?? 0})`;
    } catch (e) {
      sTag = `err(${e.message})`;
    }
    let vTag = 'skipped';
    try {
      const v = await ragicAdmin.syncVenuesFromRagic();
      vTag = `ok(${v.synced ?? 0})`;
    } catch (e) {
      vTag = `err(${e.message})`;
    }
    console.log(`[Cron/Ragic] staff=${sTag} venues=${vTag}`);
  });

  // ── 每 5 分鐘：套用「課程需求 (F-A07)」到期排程 ──
  //   scheduled_effective_date <= 現在（含日期＋時間）且有 pending_changes 的列 → 套用成正式資料。
  //   改為每 5 分鐘（原每日 01:10），使排定的「時間」一到即生效；與 GET 讀取時保險套用雙保險，皆 idempotent。
  scheduleTaipei('*/5 * * * *', async () => {
    try {
      const n = await applyDueScheduledCourseTypeChanges(pool);
      if (n) console.log(`[Cron/CourseType] 套用到期排程 ${n} 筆`);
    } catch (e) {
      console.warn('[Cron/CourseType] apply-due failed:', e.message);
    }
  });

  // ═══ 夜間 Z01/Z02 同步鏈（順序有意義，#1 成功才跑 #2/#3）═══════════════
  //   #1 00:30 本地 → Ragic 回寫（推）
  //   #2 01:30 Ragic Z01/Z02 → 本地 + Z03 分流（拉）——僅在 #1 成功後執行
  //   #3 01:45 Z01 姓名品質掃描（→ Z03/quarantine 追蹤）——同樣受 #1 閘門保護
  // 為什麼推在拉之前：本地白天的異動（櫃檯建檔、家長編修、即時同步失敗的列）要先
  // 上到 Ragic，拉回來的才是「合併後的權威狀態」；順序顛倒（舊行為：01:00 拉、02:00 推）
  // 會把 Ragic 的舊值灌回本地/Z03——本地已修好的佔位姓名又進 Z03 佇列（堵塞 Z03），
  // 隔天推回時還可能拿舊值蓋新值。

  // ── #1 每日凌晨 00:30（台北）：本地 parents/students → Ragic Z01/Z02 回寫 ──
  // 補「即時寫回失敗後從未重試」的缺口；_backupParentsStudentsImpl 每輪處理
  // ragic_record_id IS NULL 或 last_synced_at IS NULL 的待同步列。
  // 成功與否寫進 ragic_sync_log（form_code=Z01_Z02_BACKUP），#2/#3 以此為閘門。
  scheduleTaipei('30 0 * * *', async () => {
    if (!ragicAdmin.ragicEnabled()) return;
    try {
      const r = await ragicAdmin.backupParentsStudentsToRagic('cron');
      console.log(`[Cron/RagicBackup#1] synced=${r?.synced ?? 0}${r?.error ? ` error=${r.error}` : ''}`);
    } catch (e) {
      console.warn('[Cron/RagicBackup#1] failed:', e.message);
    }
  }, { timezone: 'Asia/Taipei' });

  // ── #2 每日凌晨 01:30（台北）：Ragic Z01/Z02 → 本地 parents/students 全量拉回 ──
  // 含 Z03 分流（佔位電話姓名 + 未綁定 → 本地 ragic_z03_records，不進 parents）。
  // 閘門：#1（00:30 回寫）3 小時內沒有成功紀錄 → 跳過本輪，避免把本地已修正、
  // 尚未推上去的舊 Ragic 狀態灌回 Z03。reactivate:false（不復活本地已軟刪的家長）；
  // 逐筆 try/catch，單筆壞資料不中斷整輪。
  scheduleTaipei('30 1 * * *', async () => {
    if (!ragicAdmin.ragicEnabled()) return;
    try {
      if (!(await ragicAdmin.hasRecentBackupSuccess(3))) {
        console.warn('[Cron/RagicPull#2] 跳過：#1（00:30 本地→Ragic 回寫）近 3 小時內無成功紀錄，先修復回寫再拉回，避免堵塞 Z03');
        return;
      }
      const r = await ragicAdmin.pullParentsStudentsFromRagic('cron');
      console.log(`[Cron/RagicPull#2] synced=${r?.synced ?? 0}${r?.error ? ` error=${r.error}` : ''}`);
    } catch (e) {
      console.warn('[Cron/RagicPull#2] failed:', e.message);
    }
  }, { timezone: 'Asia/Taipei' });

  // ── #3 每日凌晨 01:45（台北）：Z01 家長姓名資料品質偵測（Z01↔Z03 機制，暫僅本地追蹤）──
  // 排在 #2 拉回之後 15 分鐘，避免同時整包打 Ragic Z01；同受 #1 閘門保護（掃到的是
  // 未合併本地修正的舊狀態就沒有意義）。目前只掃「姓名疑似為電話號碼」的記錄並寫進
  // 本地 ragic_z01_quarantine 追蹤表；實際推送到 Ragic 端 Z03 表單，卡在該表單欄位
  // 定義尚未確認，見 ragicAdmin.js 內 TODO。
  scheduleTaipei('45 1 * * *', async () => {
    if (!ragicAdmin.ragicEnabled()) return;
    try {
      if (!(await ragicAdmin.hasRecentBackupSuccess(3))) {
        console.warn('[Cron/RagicQuarantine#3] 跳過：#1（00:30 本地→Ragic 回寫）近 3 小時內無成功紀錄');
        return;
      }
      const r = await ragicAdmin.quarantineBadZ01Names('cron');
      console.log(`[Cron/RagicQuarantine#3] tracked=${r?.synced ?? 0}${r?.note ? ` note=${r.note}` : ''}${r?.error ? ` error=${r.error}` : ''}`);
    } catch (e) {
      console.warn('[Cron/RagicQuarantine#3] failed:', e.message);
    }
  }, { timezone: 'Asia/Taipei' });

  console.log('[Cron] All cron jobs initialized');
}

module.exports = { initCronJobs };
