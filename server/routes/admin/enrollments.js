/**
 * 報名 / 對帳 / 退費 (F-M02 / F-R02 / F-R04)
 *  GET    /api/admin/enrollments                    ?status= &search= &venueId=
 *  POST   /api/admin/enrollments/:id/reconcile      對帳通過
 *  GET    /api/admin/enrollments/:id/refund-preview 退費預覽
 *  POST   /api/admin/enrollments/:id/refund         退課退費
 *
 * mock.js enrollments() 回傳每筆：
 *   { id, parent_name, parent_phone, students[], coach, venue_id, course_type,
 *     original_price, final_price, transfer_last_5, status, submitted_at,
 *     total_sessions, used_sessions, audit_logs[] }
 */
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole, getScopedVenueIds, isVenueInScope } = require('../../middlewares/adminAuth');
const { enqueueReconcileMail, deliverOutbox } = require('../../services/reconcileNotify');
const ragicWriteback = require('../../services/ragicWriteback');
const promotions = require('../../services/promotions');
const { resolveParentLineDisplayName } = require('../../services/parentLineProfile');
const { logGroupOrderAudit } = require('../../services/groupOrderAudit');
const { REFUND_REASON_CODES, refundReasonLabel, normalizeFeeRate } = require('../../services/refundReasons');
const {
  createCheckoutSession,
  readCheckout,
} = require('../../services/checkouts');
const {
  validateRequestId,
  payloadFingerprint,
  acquireRequestLock,
} = require('../../services/idempotency');

const router = express.Router();

// 一期固定 6 堂；手動建檔總堂數 > 6 → 依 ceil(N/6) 拆成多張訂單（每張一期）。
const SESSIONS_PER_PERIOD = 6;
const ADMIN_ENROLLMENT_OPERATION = 'admin_create_enrollment_checkout';

function adminEnrollmentResponse(checkout, { idempotent = false } = {}) {
  const orders = checkout?.sub_orders || [];
  const enrollmentIds = orders.map((order) => order.id).filter(Boolean);
  return {
    id: enrollmentIds[0] || null,
    first_id: enrollmentIds[0] || null,
    batch_id: checkout?.enrollment_batch_id || null,
    checkout_id: checkout?.checkout_id || null,
    count: enrollmentIds.length,
    enrollment_ids: enrollmentIds,
    status: orders[0]?.status || 'pending_payment',
    idempotent,
  };
}

// 與 routes/enrollments.js 同款報名單號（E + 時戳 + 亂數），各期一筆。
function genEnrollmentId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `E${ts}${rand}`;
}

async function getSettings() {
  const r = await pool.query(`SELECT key, value FROM admin_settings`);
  const out = {};
  for (const row of r.rows) out[row.key] = Number(row.value);
  return out;
}

/**
 * U9 團報橋 — 對帳通過時為團報「立即自動開通」共用 course_period（架構 v7 §9.1 Step 7）。
 *
 *  - 僅處理團報（enrollment.group_order_id 有值）；一般報名直接 return（維持原行為）。
 *  - 一團共用「一個」course_period：以 group_order_id 做冪等 get-or-create
 *    （course_periods 有 partial unique index uq_course_periods_group_order）。
 *    同團多位成員逐筆對帳時，必須等全體成員付款都 confirmed 才建 period。
 *  - 把「整團成員」綁定的正式學員（group_order_members.student_ids）加入
 *    course_period_enrollments（UNIQUE(period,student) → ON CONFLICT DO NOTHING）。
 *  - course_periods.coach_id 為 NOT NULL；團報未指定教練時無法建課 → 記 log 後略過，
 *    不阻擋對帳（報名仍轉 confirmed，待補教練後可由後台流程補開）。
 *
 *  必須在 reconcile 的交易（client）內呼叫，與報名狀態變更同生共死。
 *  totalSessions 已含期數（perPeriod × period_count），整團共用此堂數池。
 */
async function ensureGroupCoursePeriod(client, enrollment, totalSessions) {
  const groupOrderId = enrollment.group_order_id;
  if (!groupOrderId) return; // 非團報 → 不在本任務範圍

  if (!enrollment.coach_id) {
    console.warn('[reconcile/group] 團報報名缺 coach_id，略過自動開通 period:', enrollment.id, 'group:', groupOrderId);
    return;
  }

  // 訂單依期數拆分：團報每期各自一個 course_period。守門與開通都以「同一期」為範圍，
  // 讓第 1 期在全員第 1 期付清時即開課，與其他期獨立。
  const periodNumber = Number(enrollment.period_number) || 1;

  // 團報課程必須等「本期」所有成員的付款對帳都完成，才建立該期共用 course_period。
  // reconcile 會先把本筆 admin_enrollments.status 更新為 confirmed，再呼叫此函式；
  // 同一交易內查詢能看到本筆最新狀態，因此可用來當該期開通守門。
  const groupEnrollments = await client.query(
    `SELECT id, status, final_price, checkout_id, enrollment_batch_id
       FROM admin_enrollments
      WHERE group_order_id = $1 AND period_number = $2
      ORDER BY submitted_at, id`,
    [groupOrderId, periodNumber]
  );
  if (!groupEnrollments.rowCount) return;
  // 已取消/已退費的成員不算「仍在等」——否則團裡只要有一家退費，整團課程永遠建不起來。
  // 只看「仍有效」的報名：全部都 confirmed、且至少有一筆 confirmed，才開通。
  const relevant = groupEnrollments.rows.filter((row) => !['cancelled', 'refunded'].includes(row.status));
  const confirmed = relevant.filter((row) => row.status === 'confirmed');
  const waiting = relevant.filter((row) => row.status !== 'confirmed');
  if (!confirmed.length || waiting.length > 0) {
    console.warn(
      '[reconcile/group] 團報尚未全員對帳完成，暫不建立課程:',
      'group:', groupOrderId,
      'confirmed:', confirmed.length,
      'waiting:', waiting.map((row) => `${row.id}:${row.status}`).join(',') || '(無)'
    );
    return;
  }

  // 團報金流守門：每戶可以有獨立 enrollment_batch_id（兼容舊 schema 的 batch
  // 全域 unique constraint），因此以 group_order + period_number 取得全部有效 checkout。
  // 只有每戶的付款單都 paid 才開課，避免 A 家長對帳通過時提前開通 B 家長未付款的課。
  const pay = await client.query(
    `SELECT DISTINCT cs.checkout_id, cs.payment_status
       FROM checkout_sessions cs
       JOIN admin_enrollments ae ON ae.checkout_id = cs.checkout_id
      WHERE ae.group_order_id = $1
        AND ae.period_number = $2
        AND ae.status NOT IN ('cancelled','refunded')`,
    [groupOrderId, periodNumber]
  );
  const unpaid = pay.rows.filter((row) => row.payment_status !== 'paid');
  if (!pay.rowCount || unpaid.length > 0) {
    console.warn(
      '[reconcile/group] 團報尚未全數 checkout paid，暫不建立課程:',
      'group:', groupOrderId,
      'period:', periodNumber,
      'unpaid:', unpaid.map((row) => `${row.checkout_id}:${row.payment_status}`).join(',') || '(none)'
    );
    return;
  }

  const members = await client.query(
    `SELECT COALESCE(array_agg(DISTINCT sid), '{}') AS student_ids
       FROM group_order_members gom
       CROSS JOIN LATERAL unnest(gom.student_ids) AS sid
      WHERE gom.group_order_id = $1`,
    [groupOrderId]
  );
  const studentIds = (members.rows[0]?.student_ids || []).filter(Boolean);
  if (!studentIds.length) {
    console.warn('[reconcile/group] 團報全員已對帳但找不到成員學員，略過自動開通 period:', 'group:', groupOrderId);
    return;
  }

  // 共用 period 的金額＝整團所有成員報名費用總和（period 為班級層級，金額僅供參考；
  // 實際逐筆收款仍在各 admin_enrollments）。在建立前算好，ON CONFLICT 時不影響既有值。
  const groupTotalPrice = confirmed.reduce((sum, row) => sum + (Number(row.final_price) || 0), 0)
    || (Number(enrollment.final_price) || 0);

  // 同一團採 transaction-scoped advisory lock 序列化（鎖 key 刻意不含期數）。這避免依賴
  // `ON CONFLICT (group_order_id, period_number)` 推斷特定 index：某些舊 production
  // schema 尚保留單欄 group_order_id unique index，若直接推斷複合 index 會變成 500。
  // 正確的複合 unique index 仍是第二道保護；此鎖也讓舊版/新版交錯部署時行為可預期。
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1))`,
    [`group-period:${groupOrderId}`]
  );
  const ex = await client.query(
    `SELECT id FROM course_periods WHERE group_order_id = $1 AND period_number = $2 LIMIT 1`,
    [groupOrderId, periodNumber]
  );
  let periodId = ex.rows[0]?.id || null;
  if (!periodId) {
    // 不能因為「同團已有其他期」就判定 schema 尚未升級：正確的多期資料本來就會
    // 先有第 1 期、再建立第 2 期。讓資料庫真正的 unique constraints 判斷能否插入；
    // ON CONFLICT DO NOTHING 不會把目前 transaction 打進 aborted 狀態，並可兼容
    // 新舊版交錯部署時另一實例剛建立同一期的情況。
    const ins = await client.query(
      `INSERT INTO course_periods
         (coach_id, venue_id, course_type, total_sessions, used_sessions,
          expires_at, original_price, final_price, status, admin_enrollment_id, group_order_id, period_number)
       VALUES ($1,$2,$3,$4,0,(NOW() + ($5 || ' days')::interval)::date,$6,$6,'active',$7,$8,$9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        enrollment.coach_id, enrollment.venue_id, enrollment.course_type, totalSessions,
        String(365 * (Number(enrollment.period_count) || 1)),
        groupTotalPrice, enrollment.id, groupOrderId, periodNumber,
      ]
    );
    periodId = ins.rows[0]?.id || null;
    if (!periodId) {
      // 同一期並發建立成功時回收既有 id；若查不到，代表真正被 legacy
      // UNIQUE(group_order_id) 擋下，才回可診斷的 release schema 錯誤。
      const raced = await client.query(
        `SELECT id FROM course_periods WHERE group_order_id = $1 AND period_number = $2 LIMIT 1`,
        [groupOrderId, periodNumber]
      );
      periodId = raced.rows[0]?.id || null;
      if (!periodId) {
        const err = new Error('團購多期課程資料結構尚未升級，請先完成場館資料庫 release migration');
        err.code = 'GROUP_PERIOD_SCHEMA_UPGRADE_REQUIRED';
        err.statusCode = 409;
        throw err;
      }
    }
  }
  if (!periodId) return; // 理論上不會發生；保險

  for (const sid of studentIds) {
    await client.query(
      `INSERT INTO course_period_enrollments (course_period_id, student_id, status)
       VALUES ($1, $2, 'active') ON CONFLICT (course_period_id, student_id) DO NOTHING`,
      [periodId, sid]
    );
  }
}

/**
 * U11 一般報名橋 — 對帳通過時為「一般報名」（非團報）自動開通 course_period。
 *
 *  - 僅處理一般報名（enrollment.group_order_id 為 NULL）；團報交給 ensureGroupCoursePeriod，
 *    兩者以 group_order_id 守門互斥，零重複。
 *  - U12 家庭共班：家長端「同一家長多位小孩」報名一對二以上（course_type max_students > 1）時，
 *    訂單已按「學員 × 期數」拆成多筆（共用 enrollment_batch_id、同期同 period_number）。
 *    這些兄弟訂單實體上是「同一班、同一期」→ 等本期全部兄弟訂單對帳完成後，以
 *    (enrollment_batch_id, period_number) 冪等 get-or-create「一個」共用 course_period
 *    （總堂數＝每期堂數、全班共用堂數池；金額＝兄弟訂單加總），把全部小孩綁進同一 period。
 *    否則會膨脹成每位小孩各自一期（3 位小孩 × 6 堂 = 18 堂）。
 *    一對一（max_students=1）維持每筆各自開 period——多位小孩＝各自獨立的一對一堂數。
 *    家長端報名已強制學員必須屬於登入家長本人（routes/enrollments.js STUDENT_NOT_AVAILABLE），
 *    跨家庭共班唯一入口仍是團報，此處不會混入他人學員。
 *  - 補資料模型落差：admin_enrollments.students 只有姓名（TEXT[]），但 course_period_enrollments
 *    需要 students.id（UUID）→ 以 (parent_id, name) get-or-create 學員（比照 services/transfers.js）。
 *  - course_periods.coach_id 為 NOT NULL：enrollment.coach_id 為空時以 (coach 名 + venue) 反查；
 *    仍解不到教練、或家長尚未註冊 → 記 log 後 return，不阻擋對帳（維持既有寬鬆行為）。
 *  - 冪等：reconcile 已 FOR UPDATE + 狀態守門（同一筆只會對帳一次），故 check-then-insert 足夠；
 *    另有 partial unique index uq_course_periods_admin_enrollment 兜底。
 *
 *  必須在 reconcile 的交易（client）內呼叫。totalSessions 已含期數。
 *
 *  範圍說明（非本單元）：只建 course_period + course_period_enrollments，不建 course_sessions。
 *  因此對帳後「聊天室、學習歷程」立即可見；「教練課表 / 上課紀錄」仍需家長之後選槽排課才出現
 *  （與團報自動開通行為一致）。
 */
// 回傳本次「新建」的本地學員 id 陣列（新列 last_synced_at 預設 NULL＝待同步），
// 供 caller 在交易 COMMIT 後即時回寫 Ragic（best-effort；失敗由每日備份排程重試）。
async function ensureSoloCoursePeriod(client, enrollment, totalSessions) {
  const createdStudentIds = [];
  if (enrollment.group_order_id) return createdStudentIds; // 團報 → 交給 ensureGroupCoursePeriod

  // 解析教練（course_periods.coach_id NOT NULL，需容錯）：優先 coach_id，否則以 (coach 名 + venue) 反查
  let coachId = enrollment.coach_id || null;
  if (!coachId && enrollment.coach && enrollment.venue_id) {
    const cr = await client.query(
      `SELECT c.id FROM coaches c
         JOIN coach_venues cv ON cv.coach_id = c.id
        WHERE c.name = $1 AND cv.venue_id = $2
        ORDER BY c.id LIMIT 1`,
      [enrollment.coach, enrollment.venue_id]
    );
    if (cr.rowCount) coachId = cr.rows[0].id;
  }
  if (!coachId) {
    console.warn('[reconcile/solo] 一般報名無法解析教練，略過自動開通 period:', enrollment.id);
    return createdStudentIds;
  }

  // 解析家長（學員需綁到家長，家長端才讀得到自己的課）
  const pr = await client.query(
    `SELECT id FROM parents
      WHERE phone = $1
        AND is_active = TRUE
        AND line_uid IS NOT NULL AND line_uid <> ''
        AND line_uid NOT LIKE 'demo:%'
        AND line_uid NOT LIKE 'DEMOTEST_%'
      LIMIT 1`,
    [enrollment.parent_phone]
  );
  const parentId = pr.rows[0]?.id || null;
  if (!parentId) {
    console.warn('[reconcile/solo] 一般報名家長尚未完成真實 LINE 綁定，略過自動開通 period:', enrollment.id, 'phone:', enrollment.parent_phone);
    return createdStudentIds;
  }

  // U12 家庭共班判定：同批（enrollment_batch_id）同期（period_number）存在多筆兄弟訂單，
  // 且課型為一對二以上 → 走「共用 period」模式；否則維持原「每筆一 period」行為。
  const periodNumber = Number(enrollment.period_number) || 1;
  let siblingRows = null; // 非 null＝共用 period 模式（含本筆在內、本期全部有效兄弟訂單）
  if (enrollment.enrollment_batch_id && enrollment.order_kind !== 'trial') {
    const sib = await client.query(
      `SELECT id, students, status, original_price, final_price
         FROM admin_enrollments
        WHERE enrollment_batch_id = $1
          AND period_number = $2
          AND group_order_id IS NULL
          AND status NOT IN ('cancelled','refunded')
        ORDER BY submitted_at, id`,
      [enrollment.enrollment_batch_id, periodNumber]
    );
    if (sib.rowCount > 1) {
      const cfg = await client.query(
        `SELECT max_students FROM course_type_configs WHERE course_type = $1`,
        [enrollment.course_type]
      );
      if ((Number(cfg.rows[0]?.max_students) || 1) > 1) {
        // 共用開通守門（比照團報）：本期全部兄弟訂單都 confirmed 才建共用 period。
        // reconcile 已先把本筆轉 confirmed，同一交易內查得到最新狀態。
        const waiting = sib.rows.filter((row) => row.status !== 'confirmed');
        if (waiting.length) {
          console.warn(
            '[reconcile/solo] 家庭共班尚未全數對帳完成，暫不開通共用 period:',
            'batch:', enrollment.enrollment_batch_id,
            'period:', periodNumber,
            'waiting:', waiting.map((row) => `${row.id}:${row.status}`).join(',')
          );
          return createdStudentIds;
        }
        siblingRows = sib.rows;
      }
    }
  }

  let periodId = null;
  if (siblingRows) {
    // 兄弟訂單可能並發對帳（逐筆 reconcile / checkout 整單迴圈），以 advisory lock 序列化，
    // 不依賴推斷特定 unique index（比照 ensureGroupCoursePeriod 的做法）。
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`batch-period:${enrollment.enrollment_batch_id}`]
    );
    const ex = await client.query(
      `SELECT id FROM course_periods
        WHERE enrollment_batch_id = $1 AND period_number = $2 LIMIT 1`,
      [enrollment.enrollment_batch_id, periodNumber]
    );
    periodId = ex.rows[0]?.id || null;
    if (!periodId) {
      // 混版保護：舊版部署可能已替部分兄弟訂單各自建 period。此時不可再新建
      // 共用 period（堂數會重複），改「收編」最早那個為共用 period；其餘重複
      // period 由 scripts/merge_family_shared_periods.js 修復合併。
      const legacy = await client.query(
        `SELECT id FROM course_periods
          WHERE admin_enrollment_id = ANY($1::text[]) AND group_order_id IS NULL
          ORDER BY created_at, id LIMIT 1`,
        [siblingRows.map((row) => row.id)]
      );
      if (legacy.rowCount) {
        periodId = legacy.rows[0].id;
        await client.query(
          `UPDATE course_periods
              SET enrollment_batch_id = $2, period_number = $3, updated_at = NOW()
            WHERE id = $1`,
          [periodId, enrollment.enrollment_batch_id, periodNumber]
        );
      }
    }
    if (!periodId) {
      // 共用 period 金額＝本期全部兄弟訂單加總（period 為班級層級金額，
      // 逐筆收款／發票仍在各 admin_enrollments）。堂數＝每期堂數，全班共用。
      const originalSum = siblingRows.reduce((sum, row) => sum + (Number(row.original_price) || 0), 0);
      const finalSum = siblingRows.reduce((sum, row) => sum + (Number(row.final_price) || 0), 0);
      const ins = await client.query(
        `INSERT INTO course_periods
           (coach_id, venue_id, course_type, total_sessions, used_sessions,
            expires_at, original_price, final_price, status, admin_enrollment_id,
            enrollment_batch_id, period_number)
         VALUES ($1,$2,$3,$4,0,(NOW() + ($5 || ' days')::interval)::date,$6,$7,'active',$8,$9,$10)
         RETURNING id`,
        [
          coachId, enrollment.venue_id, enrollment.course_type, totalSessions,
          String(365 * (Number(enrollment.period_count) || 1)),
          originalSum, finalSum,
          siblingRows[0].id, enrollment.enrollment_batch_id, periodNumber,
        ]
      );
      periodId = ins.rows[0]?.id || null;
    }
  } else {
    // get-or-create course_period（以 admin_enrollment_id 冪等；一般報名 group_order_id 為 NULL）
    const exist = await client.query(
      `SELECT id FROM course_periods WHERE admin_enrollment_id = $1 AND group_order_id IS NULL LIMIT 1`,
      [enrollment.id]
    );
    periodId = exist.rows[0]?.id || null;
    if (!periodId) {
      // 試上（order_kind='trial'）＝單堂體驗：效期縮短為 30 天（政策 2026-07-16，PRP §8-6a），
      // 一般報名維持 365 天 × 期數不變。
      const validityDays = enrollment.order_kind === 'trial'
        ? '30'
        : String(365 * (Number(enrollment.period_count) || 1));
      const ins = await client.query(
        `INSERT INTO course_periods
           (coach_id, venue_id, course_type, total_sessions, used_sessions,
            expires_at, original_price, final_price, status, admin_enrollment_id, is_experience_course)
         VALUES ($1,$2,$3,$4,0,(NOW() + ($5 || ' days')::interval)::date,$6,$7,'active',$8,$9)
         RETURNING id`,
        [
          coachId, enrollment.venue_id, enrollment.course_type, totalSessions,
          validityDays,
          Number(enrollment.original_price) || 0, Number(enrollment.final_price) || 0,
          enrollment.id, enrollment.order_kind === 'trial',
        ]
      );
      periodId = ins.rows[0]?.id || null;
    }
  }
  if (!periodId) return createdStudentIds;

  // get-or-create 學員（以 parent_id + name）→ 綁進 course_period_enrollments。
  // 共用 period 模式：綁「本期全部兄弟訂單」的學員（每筆家長端子訂單只有 1 位）。
  const names = siblingRows
    ? [...new Set(siblingRows.flatMap((row) => row.students || []).filter(Boolean))]
    : (enrollment.students || []).filter(Boolean);
  for (const name of names) {
    const se = await client.query(
      `SELECT id FROM students WHERE parent_id = $1 AND name = $2 LIMIT 1`,
      [parentId, name]
    );
    let sid = se.rows[0]?.id;
    if (!sid) {
      const si = await client.query(
        `INSERT INTO students (parent_id, name) VALUES ($1, $2) RETURNING id`,
        [parentId, name]
      );
      sid = si.rows[0].id;
      createdStudentIds.push(sid);
    }
    await client.query(
      `INSERT INTO course_period_enrollments (course_period_id, student_id, status)
       VALUES ($1, $2, 'active') ON CONFLICT (course_period_id, student_id) DO NOTHING`,
      [periodId, sid]
    );
  }
  return createdStudentIds;
}

function tsToString(d) {
  if (!d) return null;
  if (typeof d === 'string') return d;
  // 必須保留 Z。切掉時區標記會把「明確的 UTC 時刻」變成「意義不明的本地時間」：
  // 前端 new Date("2026-08-04T10:48:34") 依規範當本地時間解讀，於是台北 18:48 的
  // 報名在畫面上顯示成 10:48 —— 送出時間、退費時間、發票時間、操作紀錄全少 8 小時。
  return new Date(d).toISOString();
}

async function readEnrollment(id, { resolveLineProfile = false } = {}) {
  const e = await pool.query(
    `SELECT ae.*, au.name AS created_by_name,
            p.line_uid AS parent_line_uid,
            plp.display_name AS line_display_name,
            plp.source AS line_profile_source
       FROM admin_enrollments ae
       LEFT JOIN admin_users au ON au.id = ae.created_by
       LEFT JOIN parents p ON p.is_active=TRUE
         AND regexp_replace(COALESCE(p.phone,''),'\\D','','g') =
             regexp_replace(COALESCE(ae.parent_phone,''),'\\D','','g')
       LEFT JOIN parent_line_profiles plp ON plp.line_uid=p.line_uid
      WHERE ae.id = $1`,
    [id]
  );
  if (!e.rowCount) return null;
  const a = await pool.query(
    `SELECT at, action, by_user, reason, refund_amount FROM admin_enrollment_audit_logs
     WHERE enrollment_id = $1 ORDER BY at ASC, id ASC`,
    [id]
  );
  const row = e.rows[0];
  let lineDisplayName = row.line_display_name || '';
  let lineProfileState = lineDisplayName ? 'CACHED' : (row.parent_line_uid ? 'NOT_CACHED' : 'NOT_BOUND');
  if (resolveLineProfile && row.parent_line_uid && !lineDisplayName) {
    const profile = await resolveParentLineDisplayName({
      lineUid: row.parent_line_uid,
      venueId: row.venue_id,
    });
    lineDisplayName = profile.displayName || '';
    lineProfileState = profile.state;
  }
  return {
    id: row.id,
    parent_name: row.parent_name,
    parent_phone: row.parent_phone,
    line_display_name: lineDisplayName,
    line_bound: Boolean(row.parent_line_uid),
    line_profile_state: lineProfileState,
    students: row.students || [],
    coach: row.coach,
    coach_id: row.coach_id || null,
    venue_id: row.venue_id,
    course_type: row.course_type,
    original_price: Number(row.original_price),
    final_price: Number(row.final_price),
    transfer_last_5: row.transfer_last_5,
    carrier: row.carrier || null,
    status: row.status,
    submitted_at: tsToString(row.submitted_at),
    total_sessions: row.total_sessions,
    used_sessions: row.used_sessions,
    refund_amount: row.refund_amount != null ? Number(row.refund_amount) : undefined,
    refunded_at: tsToString(row.refunded_at),
    invoice_number: row.invoice_number || null,
    invoice_image_url: row.invoice_image_url || null,
    payment_proof_url: row.payment_proof_url || null,
    payment_method: row.payment_method || 'bank_transfer',
    order_kind: row.order_kind || 'standard',
    invoice_url: row.invoice_url || null,
    invoice_issued_at: tsToString(row.invoice_issued_at),
    extra_parent_phones: row.extra_parent_phones || [],
    notes: row.notes || null,
    group_order_id: row.group_order_id || null,
    is_group_shared: !!row.is_group_shared,
    period_count: Number(row.period_count) || 1,
    period_number: Number(row.period_number) || 1,
    enrollment_batch_id: row.enrollment_batch_id || null,
    created_by: row.created_by || null,
    created_by_name: row.created_by_name || null,
    audit_logs: a.rows.map((x) => ({
      at: tsToString(x.at),
      action: x.action,
      by: x.by_user,
      ...(x.reason ? { reason: x.reason } : {}),
      ...(x.refund_amount != null ? { refund_amount: Number(x.refund_amount) } : {}),
    })),
  };
}

/**
 * POST /api/admin/enrollments  — 櫃檯手動建檔（建立報名）
 *
 *  「報名與對帳 → 手動建檔」頁呼叫。家長/學員已先在 Z01/Z02 搜尋連結（或新建），
 *  此處只收已解析好的 parent_name/phone + students[] 名單。
 *
 *  與家長端 routes/enrollments.js 的差異：
 *    - 身份由 admin 指定（非 JWT 家長），需 admin/manager/staff，且 venue 須在可見範圍。
 *    - 金額以櫃檯輸入為準（不重算優惠）。
 *    - 嚴格拆期：1 期 = 6 堂；total_sessions > 6 → ceil(N/6) 拆成多筆 admin_enrollments
 *      （每筆 period_count=1、共用 enrollment_batch_id），原價/實收/折讓依堂數比例分攤。
 *    - 狀態一律 pending_payment（待對帳）→ 自動出現在「所有報名」與「待對帳/匯款查詢」；
 *      正式 course_period 由既有對帳流程 (reconcile) 產生。
 *    - 本路由「不寫 Ragic」。報名回寫 Ragic Z01/Z02 連結表 + webhook 雙向同步為 Phase 3/4，
 *      屆時於 COMMIT 後依 external_order_no/ragic_record_id 接上（見 011 migration 橋接欄）。
 */
router.post('/', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  const b = req.body || {};
  const requestCheck = validateRequestId(b.request_id || req.get('Idempotency-Key'));
  if (requestCheck.error) {
    return res.status(requestCheck.status).json({ error: requestCheck.error, code: requestCheck.code });
  }
  const idempotencyKey = requestCheck.requestId;
  const actorId = String(req.adminUser?.sub || req.adminUser?.username || '').trim();
  if (!actorId) return res.status(403).json({ error: '無法確認建檔操作人員', code: 'ACTOR_REQUIRED' });

  const parentName  = String(b.parent_name || '').trim();
  const parentPhone = String(b.parent_phone || '').trim();
  const venueId     = String(b.venue_id || '').trim();
  const coachName   = String(b.coach || '').trim();
  const courseType  = Number(b.course_type);
  const students    = Array.isArray(b.students)
    ? b.students.map((s) => String(s || '').trim()).filter(Boolean) : [];
  const totalSessions = Number.parseInt(b.total_sessions, 10);

  if (!parentName || !parentPhone) return res.status(400).json({ error: '請填寫家長姓名與電話', code: 'PARENT_REQUIRED' });
  if (!venueId) return res.status(400).json({ error: '請選擇館別', code: 'VENUE_REQUIRED' });
  if (!coachName) return res.status(400).json({ error: '請填寫授課教練', code: 'COACH_REQUIRED' });
  if (!Number.isInteger(courseType) || courseType < 1) return res.status(400).json({ error: '請選擇課程組別', code: 'COURSE_TYPE_INVALID' });
  if (!students.length) return res.status(400).json({ error: '請填寫至少一位學員', code: 'STUDENT_REQUIRED' });
  if (!Number.isInteger(totalSessions) || totalSessions < 1) return res.status(400).json({ error: '請填寫有效的總堂數', code: 'SESSIONS_INVALID' });

  // 場館權限（manager/staff 只能建自己館；admin 全部）。
  if (!isVenueInScope(req, venueId)) return res.status(403).json({ error: '無此館別的建檔權限', code: 'VENUE_OUT_OF_SCOPE' });

  // 付款：轉帳須有末 5 碼格式；現金可空。
  const paymentMethod = String(b.payment_method || '').trim() || null;
  const last5 = String(b.transfer_last_5 || '').trim();
  if (last5 && !/^\d{5}$/.test(last5)) return res.status(400).json({ error: '轉帳末 5 碼格式錯誤', code: 'TRANSFER_LAST5_INVALID' });

  // 金額（櫃檯輸入為準，整筆 N 堂的原價 / 實收 / 折讓）。
  const originalPrice  = Number(b.original_price);
  const finalPrice     = Number(b.final_price);
  const allowanceTotal = b.allowance_amount != null && b.allowance_amount !== '' ? Number(b.allowance_amount) : 0;
  if (!Number.isFinite(originalPrice) || originalPrice < 0
      || !Number.isFinite(finalPrice) || finalPrice < 0
      || !Number.isFinite(allowanceTotal) || allowanceTotal < 0) {
    return res.status(400).json({ error: '金額格式不正確', code: 'PRICE_INVALID' });
  }

  // 選填的報名表外觀欄位（同一筆購買，落在每張拆分訂單上）。NaN 一律降為 NULL（避免寫壞數值欄）。
  const unitPriceRaw = b.unit_price != null && b.unit_price !== '' ? Number(b.unit_price) : null;
  const unitPrice = Number.isFinite(unitPriceRaw) ? unitPriceRaw : null;
  const payer      = String(b.payer || '').trim() || null;       // 收款人
  const className  = String(b.class_name || '').trim() || null;  // 班級名稱
  const taxId      = String(b.tax_id || '').trim() || null;      // 統一編號
  const levelNote  = String(b.level_note || '').trim() || null;  // 程度說明
  const workType   = String(b.work_type || '').trim() || null;   // 作業型態
  const carrier    = String(b.carrier || '').trim() || null;     // 載具
  const fullSessionsRaw = b.full_sessions != null && b.full_sessions !== '' ? Number.parseInt(b.full_sessions, 10) : null;
  const fullSessions = Number.isInteger(fullSessionsRaw) ? fullSessionsRaw : null;
  const submittedAt = b.submitted_at ? new Date(b.submitted_at) : new Date();
  if (Number.isNaN(submittedAt.getTime())) return res.status(400).json({ error: '報名日期格式不正確', code: 'SUBMITTED_AT_INVALID' });
  const byUser = req.adminUser?.name || req.adminUser?.username || req.adminUser?.sub || 'admin';
  // C-6：資料建立人一律從登入 token 決定（FK 到 admin_users.id），不接受前端傳值。
  const createdBy = req.adminUser?.sub || null;
  const fingerprint = payloadFingerprint({
    parent_name: parentName,
    parent_phone: parentPhone,
    students,
    venue_id: venueId,
    coach: coachName,
    coach_id: b.coach_id ? String(b.coach_id).trim() : null,
    course_type: courseType,
    total_sessions: totalSessions,
    original_price: originalPrice,
    final_price: finalPrice,
    allowance_amount: allowanceTotal,
    payment_method: paymentMethod,
    transfer_last_5: last5 || null,
    unit_price: unitPrice,
    payer,
    class_name: className,
    tax_id: taxId,
    level_note: levelNote,
    work_type: workType,
    full_sessions: fullSessions,
    carrier,
    submitted_at: b.submitted_at ? submittedAt.toISOString() : null,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 與家長報名相同：actor/request advisory lock → ledger → business rows。
    // 同一 request 的重送在任何 checkout/order/audit 副作用前即完成序列化。
    await acquireRequestLock(client, {
      actorId,
      operation: ADMIN_ENROLLMENT_OPERATION,
      requestId: idempotencyKey,
    });
    const prior = await client.query(
      `SELECT payload_fingerprint, result_entity_id, status
         FROM request_idempotency_ledger
        WHERE actor_type = 'admin' AND actor_id = $1
          AND operation = $2 AND normalized_request_id = $3
        FOR UPDATE`,
      [actorId, ADMIN_ENROLLMENT_OPERATION, idempotencyKey]
    );
    if (prior.rowCount) {
      const ledger = prior.rows[0];
      if (ledger.payload_fingerprint !== fingerprint) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '相同 request ID 已用於不同建檔內容',
          code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        });
      }
      if (ledger.status !== 'completed' || !ledger.result_entity_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '此 request ID 正在處理，請稍後以相同內容重試',
          code: 'IDEMPOTENCY_IN_PROGRESS',
        });
      }
      const existingCheckout = await readCheckout(client, ledger.result_entity_id);
      if (!existingCheckout?.sub_orders?.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '此 request ID 的原始建檔結果不存在，請聯繫管理員',
          code: 'IDEMPOTENCY_RESULT_MISSING',
        });
      }
      await client.query('COMMIT');
      return res.json(adminEnrollmentResponse(existingCheckout, { idempotent: true }));
    }
    await client.query(
      `INSERT INTO request_idempotency_ledger
         (normalized_request_id, actor_type, actor_id, operation, payload_fingerprint, status)
       VALUES ($1,'admin',$2,$3,$4,'processing')`,
      [idempotencyKey, actorId, ADMIN_ENROLLMENT_OPERATION, fingerprint]
    );

    // 場館須存在；停用館仍允許（補登歷史 / 舊資料匯入）。
    const vr = await client.query(`SELECT id FROM venues WHERE id = $1`, [venueId]);
    if (!vr.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '館別不存在', code: 'VENUE_NOT_FOUND' });
    }
    // 教練：可帶 coach_id（active coaches）取代自由文字；否則僅存名稱（對帳時再反查）。
    let coachId = null;
    const rawCoachId = b.coach_id ? String(b.coach_id).trim() : '';
    if (rawCoachId) {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(rawCoachId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'coach_id 格式不正確', code: 'COACH_ID_INVALID' });
      }
      const cr = await client.query(`SELECT id FROM coaches WHERE id = $1`, [rawCoachId]);
      if (cr.rowCount) coachId = rawCoachId;
    }

    // 嚴格拆期：N 堂 → ceil(N/6) 筆，最後一筆放餘數堂；原價/實收/折讓按堂數比例分攤、餘額補最後一筆。
    const numPeriods = Math.ceil(totalSessions / SESSIONS_PER_PERIOD);
    const batchId = randomUUID();
    const enrollmentIds = [];
    let origAlloc = 0, finalAlloc = 0, allowAlloc = 0;
    const parentMatch = await client.query(`SELECT id FROM parents WHERE phone = $1 LIMIT 1`, [parentPhone]);
    const checkout = await createCheckoutSession(client, {
      parentId: parentMatch.rows[0]?.id || null,
      enrollmentBatchId: batchId,
      totalAmount: finalPrice,
      transferLast5: last5 || null,
      carrier,
      by: byUser,
      requestFingerprint: fingerprint,
    });

    for (let i = 0; i < numPeriods; i += 1) {
      const isLast = i === numPeriods - 1;
      const periodSessions = isLast ? (totalSessions - SESSIONS_PER_PERIOD * (numPeriods - 1)) : SESSIONS_PER_PERIOD;
      const po = isLast ? (originalPrice - origAlloc)  : Math.round(originalPrice * periodSessions / totalSessions);
      const pf = isLast ? (finalPrice - finalAlloc)    : Math.round(finalPrice * periodSessions / totalSessions);
      const pa = isLast ? (allowanceTotal - allowAlloc) : Math.round(allowanceTotal * periodSessions / totalSessions);
      if (!isLast) { origAlloc += po; finalAlloc += pf; allowAlloc += pa; }

      const eid = genEnrollmentId();
      enrollmentIds.push(eid);
      await client.query(
        `INSERT INTO admin_enrollments
           (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
            original_price, final_price, transfer_last_5, status, submitted_at,
            total_sessions, used_sessions, period_count, period_number, enrollment_batch_id,
            checkout_id, payment_method, payer, class_name, allowance_amount, tax_id, level_note,
            unit_price, work_type, full_sessions, carrier, sync_source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending_payment',$12,
                 $13,0,1,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'replit',$27)`,
        [
          eid, parentName, parentPhone, students, coachName, coachId, venueId, courseType,
          po, pf, last5 || null, submittedAt,
          periodSessions, i + 1, batchId, checkout.checkoutId,
          paymentMethod, payer, className, pa, taxId, levelNote,
          unitPrice, workType, fullSessions, carrier, createdBy,
        ]
      );
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
         VALUES ($1, $2, $3)`,
        [eid, numPeriods > 1 ? `櫃檯手動建檔（第 ${i + 1}/${numPeriods} 期）` : '櫃檯手動建檔', byUser]
      );
    }

    await client.query(
      `UPDATE request_idempotency_ledger
          SET result_entity_id = $4, status = 'completed', completed_at = NOW()
        WHERE actor_type = 'admin' AND actor_id = $1
          AND operation = $2 AND normalized_request_id = $3`,
      [actorId, ADMIN_ENROLLMENT_OPERATION, idempotencyKey, checkout.checkoutId]
    );

    await client.query('COMMIT');
    res.status(201).json({
      id: enrollmentIds[0],
      first_id: enrollmentIds[0],
      batch_id: batchId,
      checkout_id: checkout.checkoutId,
      count: numPeriods,
      enrollment_ids: enrollmentIds,
      status: 'pending_payment',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/enrollments create]', { code: err?.code || 'UNEXPECTED' });
    res.status(500).json({ error: '手動建檔失敗', code: 'CREATE_FAILED' });
  } finally {
    client.release();
  }
});

router.get('/', requireAdminAuth, async (req, res) => {
  try {
    const { status, search } = req.query;
    // Task #90：場館範圍 — staff/manager 鎖在自己所屬全部場館；admin 可帶 venueId 自由查
    const scope = getScopedVenueIds(req);
    const where = [];
    const args = [];
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    if (scope) {
      args.push(scope);
      where.push(`venue_id = ANY($${args.length}::text[])`);
      // manager 可在自己場館範圍內再用 venueId 縮小
      if (req.query.venueId && scope.includes(String(req.query.venueId))) {
        args.push(String(req.query.venueId));
        where.push(`venue_id = $${args.length}`);
      }
    } else if (req.query.venueId) {
      args.push(req.query.venueId);
      where.push(`venue_id = $${args.length}`);
    }
    if (search) {
      args.push(`%${search.toLowerCase()}%`);
      const idx = args.length;
      where.push(`(
        LOWER(parent_name) LIKE $${idx} OR
        parent_phone LIKE $${idx} OR
        LOWER(coach) LIKE $${idx} OR
        LOWER(id) LIKE $${idx} OR
        EXISTS (SELECT 1 FROM unnest(students) s WHERE LOWER(s) LIKE $${idx})
      )`);
    }
    const sql = `SELECT id FROM admin_enrollments
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY submitted_at DESC`;
    const r = await pool.query(sql, args);
    const out = [];
    for (const row of r.rows) out.push(await readEnrollment(row.id));
    res.json(out);
  } catch (err) {
    console.error('[admin/enrollments]', err);
    res.status(500).json({ error: 'list enrollments failed' });
  }
});

// 明細才 best-effort 取 LINE display name；清單絕不會對 LINE API 產生 N+1 calls。
router.get('/:id', requireAdminAuth, async (req, res) => {
  try {
    const basic = await readEnrollment(req.params.id);
    if (!basic) return res.status(404).json({ error: '報名不存在' });
    if (!isVenueInScope(req, basic.venue_id)) return res.status(403).json({ error: '無權限查看此報名' });
    return res.json(await readEnrollment(req.params.id, { resolveLineProfile: true }));
  } catch (err) {
    console.error('[admin/enrollments/:id]', err);
    return res.status(500).json({ error: 'read enrollment failed' });
  }
});

/**
 * PATCH /api/admin/enrollments/:id  — 後台編輯報名基本資料
 * 可編輯欄位：parent_name, parent_phone, students[], coach, course_type,
 *             original_price, final_price, transfer_last_5,
 *             extra_parent_phones[], notes
 * 不可在 cancelled / refunded 狀態下修改（業務資料已結案）。
 */
router.patch('/:id', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const body = req.body || {};
    const cur = await client.query(`SELECT * FROM admin_enrollments WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '報名不存在' });
    }

    const row = cur.rows[0];
    if (!isVenueInScope(req, row.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
    }
    if (['cancelled', 'refunded'].includes(row.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `狀態 ${row.status} 的報名不可再編輯` });
    }

    // 允許部分更新，未傳的欄位保留原值
    const parentName       = body.parent_name       !== undefined ? String(body.parent_name).trim()   : row.parent_name;
    const parentPhone      = body.parent_phone      !== undefined ? String(body.parent_phone).trim()  : row.parent_phone;
    const students         = Array.isArray(body.students)         ? body.students.map((s) => String(s).trim()).filter(Boolean) : row.students;
    const courseType       = body.course_type       !== undefined ? Number(body.course_type)           : row.course_type;
    const originalPrice    = body.original_price    !== undefined ? Number(body.original_price)        : row.original_price;
    const finalPrice       = body.final_price       !== undefined ? Number(body.final_price)           : row.final_price;
    const transferLast5    = body.transfer_last_5   !== undefined ? String(body.transfer_last_5).trim() : row.transfer_last_5;
    const extraPhones      = Array.isArray(body.extra_parent_phones)
      ? body.extra_parent_phones.map((p) => String(p).trim()).filter(Boolean)
      : (row.extra_parent_phones || []);
    const notes            = body.notes             !== undefined ? (body.notes ? String(body.notes).trim() : null) : row.notes;

    // venue / coach 變更：venue_id 走 admin_venues 驗證；coach_id 走 coaches + coach_venues 驗證
    let venueId  = row.venue_id;
    let venueName = null;
    let coachId   = row.coach_id || null;
    let coachName = row.coach;

    if (body.venue_id !== undefined) {
      venueId = String(body.venue_id).trim();
      // Task #90：變更場館時，目標場館必須在自己所屬範圍內（manager 不能把報名搬到別館）
      if (!isVenueInScope(req, venueId)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: '目標場館不在您的場館範圍內' });
      }
      const vr = await client.query(`SELECT id, name FROM admin_venues WHERE id = $1`, [venueId]);
      if (!vr.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `場館不存在：${venueId}` });
      }
      venueName = vr.rows[0].name;
    }
    if (body.coach_id !== undefined && body.coach_id) {
      coachId = String(body.coach_id).trim();
      const cr = await client.query(
        `SELECT c.id, c.name FROM coaches c WHERE c.id = $1 AND c.is_active = TRUE`,
        [coachId]
      );
      if (!cr.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '教練不存在或已停用' });
      }
      coachName = cr.rows[0].name;
      // 驗證該教練屬於目標場館
      const cv = await client.query(
        `SELECT 1 FROM coach_venues WHERE coach_id = $1 AND venue_id = $2`,
        [coachId, venueId]
      );
      if (!cv.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '此教練不在所選場館' });
      }
    } else if (body.coach !== undefined) {
      // 向後相容：純文字編輯（不指定 coach_id）
      coachName = String(body.coach).trim();
    }

    if (!parentName) { await client.query('ROLLBACK'); return res.status(400).json({ error: '家長姓名必填' }); }
    if (!parentPhone) { await client.query('ROLLBACK'); return res.status(400).json({ error: '家長手機必填' }); }
    if (!students || students.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: '學員名稱必填' }); }
    if (!coachName) { await client.query('ROLLBACK'); return res.status(400).json({ error: '教練必填' }); }
    // 一致性硬規則：venue_id 變更時必須在同一 request 顯式帶 coach_id
    // （避免直接打 API 只改場館卻沿用舊教練 → venue/coach 不匹配）
    if (venueId !== row.venue_id && (body.coach_id === undefined || !body.coach_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '變更場館時必須同時指定該場館的教練（coach_id）' });
    }

    await client.query(
      `UPDATE admin_enrollments SET
         parent_name        = $2,
         parent_phone       = $3,
         students           = $4,
         coach              = $5,
         coach_id           = $6,
         venue_id           = $7,
         course_type        = $8,
         original_price     = $9,
         final_price        = $10,
         transfer_last_5    = $11,
         extra_parent_phones = $12,
         notes              = $13,
         updated_at         = NOW()
       WHERE id = $1`,
      [id, parentName, parentPhone, students, coachName, coachId, venueId, courseType,
       originalPrice, finalPrice, transferLast5, extraPhones, notes]
    );

    const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
    const oldCoachName  = row.coach;
    const oldVenueId    = row.venue_id;
    const venueChanged  = venueId !== oldVenueId;
    const coachChanged  = (coachId && coachId !== row.coach_id) || (coachName !== oldCoachName);
    let reassignedSessions = 0;

    // 教練 / 場館變更 → 同步未來尚未上課的 sessions（best-effort）
    // 透過 course_periods.admin_enrollment_id 軟連結；舊資料無連結時，這裡用
    // (parent_phone + 舊 coach + 舊 venue) 做一次 lazy backfill，讓首次轉教練也能生效。
    if ((coachChanged || venueChanged) && coachId) {
      // Resolve 舊 coach UUID（admin_enrollments.coach_id 在升級前可能為 NULL，靠名稱反查）
      let oldCoachUuid = row.coach_id;
      if (!oldCoachUuid && row.coach && row.venue_id) {
        const r2 = await client.query(
          `SELECT c.id FROM coaches c
             JOIN coach_venues cv ON cv.coach_id = c.id
            WHERE c.name = $1 AND cv.venue_id = $2 LIMIT 1`,
          [row.coach, row.venue_id]
        );
        if (r2.rowCount) oldCoachUuid = r2.rows[0].id;
      }
      // Lazy backfill admin_enrollment_id（嚴格安全模式）：
      //   只有在 (parent_phone + 舊 coach + 舊 venue + course_type) 命中且
      //   ① 該 parent 在系統內僅有一筆同條件之 admin_enrollment（即本筆）
      //   ② 命中的 period 也尚未被任何其他 admin_enrollment_id 連結
      //   時才執行，避免多筆同手機/同教練的報名互相錯置。
      if (oldCoachUuid) {
        const ambiguity = await client.query(
          `SELECT COUNT(*)::int AS n FROM admin_enrollments
            WHERE parent_phone = $1 AND course_type = $2
              AND COALESCE(coach_id, '00000000-0000-0000-0000-000000000000'::uuid) = $3
              AND venue_id = $4`,
          [row.parent_phone, row.course_type, oldCoachUuid, row.venue_id]
        );
        if (ambiguity.rows[0].n <= 1) {
          await client.query(
            `UPDATE course_periods cp
                SET admin_enrollment_id = $1
              WHERE cp.admin_enrollment_id IS NULL
                AND cp.coach_id = $2
                AND cp.venue_id = $3
                AND cp.course_type = $5
                AND EXISTS (
                  SELECT 1 FROM course_period_enrollments cpe
                    JOIN students s ON s.id = cpe.student_id
                    JOIN parents  p ON p.id = s.parent_id
                   WHERE cpe.course_period_id = cp.id AND p.phone = $4
                )`,
            [id, oldCoachUuid, row.venue_id, row.parent_phone, row.course_type]
          );
        }
      }
      const periods = await client.query(
        `SELECT id FROM course_periods WHERE admin_enrollment_id = $1`, [id]
      );
      const periodIds = periods.rows.map((r) => r.id);
      if (periodIds.length > 0) {
        // 既有課堂若沒有 session.coach_id，查詢會以 course_periods.coach_id 代入；
        // 先把它們固定為原教練，避免中途換教練後過去紀錄整批跑到新教練名下。
        if (oldCoachUuid) {
          await client.query(
            `UPDATE course_sessions
                SET coach_id = $2, updated_at = NOW()
              WHERE course_period_id = ANY($1::uuid[])
                AND coach_id IS NULL`,
            [periodIds, oldCoachUuid]
          );
        }
        // 1) 更新 period 主檔（讓教練 LIFF 的「我的學員 / 今日課程」立即看到）
        await client.query(
          `UPDATE course_periods SET coach_id = $2, venue_id = $3, updated_at = NOW()
             WHERE id = ANY($1::uuid[])`,
          [periodIds, coachId, venueId]
        );
        // 2) 只覆寫未來尚未上課的 sessions 之 coach_id（已上課保留原值）。
        //    F2：同時把「轉走前的原教練」存進 reassigned_from_coach_id（RHS coach_id 為更新前舊值），
        //    COALESCE 確保多次轉派仍保留最初的原教練，供新教練端顯示「原授課教練」。
        const upd = await client.query(
          `UPDATE course_sessions
              SET reassigned_from_coach_id = COALESCE(reassigned_from_coach_id, coach_id),
                  coach_id = $2, updated_at = NOW()
            WHERE course_period_id = ANY($1::uuid[])
              AND scheduled_at > NOW()
              AND status IN ('confirmed','pending_group_confirm')
              AND coach_id IS DISTINCT FROM $2`,
          [periodIds, coachId]
        );
        reassignedSessions = upd.rowCount || 0;
      }
    }

    // Audit log
    if (coachChanged || venueChanged) {
      const reasonParts = [];
      if (venueChanged) reasonParts.push(`場館 ${oldVenueId} → ${venueId}`);
      if (coachChanged) reasonParts.push(`教練 ${oldCoachName} → ${coachName}`);
      if (reassignedSessions > 0) reasonParts.push(`重新指派 ${reassignedSessions} 堂未來課程`);
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs
           (enrollment_id, action, by_user, reason,
            before_coach_id, after_coach_id, before_coach, after_coach,
            before_venue_id, after_venue_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, 'transfer_coach', by, reasonParts.join('；'),
         row.coach_id || null, coachId || null, oldCoachName || null, coachName || null,
         oldVenueId || null, venueId || null]
      );
    } else {
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user) VALUES ($1, $2, $3)`,
        [id, '後台編輯報名資料', by]
      );
    }

    await client.query('COMMIT');
    const out = await readEnrollment(id);
    res.json({ ...out, _transfer: { coach_changed: coachChanged, venue_changed: venueChanged, reassigned_sessions: reassignedSessions } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/enrollments patch]', err);
    res.status(500).json({ error: 'update failed' });
  } finally {
    client.release();
  }
});

// 對帳改由「行政櫃檯(staff)」處理（原僅 admin/manager）。退費(F-R04) 不在此調整範圍。
router.post('/:id/reconcile', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const body = req.body || {};
    const by = body.by || req.adminUser?.name || req.adminUser?.username || 'unknown';

    // Task #39：發票號碼 + 圖片 URL 為必填
    const invoiceNumber = (body.invoice_number || '').trim();
    const invoiceImageUrl = (body.invoice_image_url || '').trim();
    const invoiceUrl = (body.invoice_url || '').trim();

    if (!invoiceNumber) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '發票號碼必填' });
    }
    if (!/^[A-Z]{2}\d{8}$/.test(invoiceNumber)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '發票號碼格式錯誤（應為 2 大寫英文 + 8 數字）' });
    }
    if (!invoiceImageUrl) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '發票照片必填' });
    }

    const cur = await client.query(`SELECT * FROM admin_enrollments WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'enrollment not found' });
    }
    if (!isVenueInScope(req, cur.rows[0].venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
    }
    if (cur.rows[0].status !== 'pending_payment') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '此筆狀態非待對帳' });
    }

    const settings = await getSettings();
    const perPeriod = settings.sessions_per_period || 6;
    // U9：一張報名可購買多期 → 總堂數 = 每期堂數 × 期數（一般報名 period_count 預設 1，行為不變）。
    const periodCount = Number(cur.rows[0].period_count) || 1;
    // 試上為明確單次課，不得在對帳時被既有「每期 N 堂」邏輯放大成完整一期。
    const total = cur.rows[0].order_kind === 'trial' ? 1 : (perPeriod * periodCount);

    await client.query(
      `UPDATE admin_enrollments
         SET status = 'confirmed',
             total_sessions = $2,
             used_sessions = 0,
             invoice_number = $3,
             invoice_image_url = $4,
             invoice_url = $5,
             invoice_issued_at = NOW(),
             updated_at = NOW()
       WHERE id = $1`,
      [id, total, invoiceNumber, invoiceImageUrl, invoiceUrl || null]
    );
    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
       VALUES ($1, $2, $3)`,
      [id, `對帳通過（發票 ${invoiceNumber}）`, by]
    );
    if (cur.rows[0].checkout_id) {
      await client.query(
        `INSERT INTO checkout_invoices
           (checkout_id, order_id, family_key, buyer_name, amount, invoice_number, invoice_image_url, invoice_url, issued_at)
         VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (checkout_id) WHERE order_id IS NULL AND family_key IS NULL
         DO UPDATE SET buyer_name = EXCLUDED.buyer_name,
                       amount = EXCLUDED.amount,
                       invoice_number = EXCLUDED.invoice_number,
                       invoice_image_url = EXCLUDED.invoice_image_url,
                       invoice_url = EXCLUDED.invoice_url,
                       issued_at = EXCLUDED.issued_at,
                       updated_at = NOW()`,
        [cur.rows[0].checkout_id, cur.rows[0].parent_name, cur.rows[0].final_price, invoiceNumber, invoiceImageUrl, invoiceUrl || null]
      );
      await client.query(
        `UPDATE checkout_sessions cs
            SET payment_status = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM admin_enrollments ae
                     WHERE ae.checkout_id = cs.checkout_id
                       AND ae.status NOT IN ('confirmed','active','cancelled','refunded')
                  ) THEN 'paid'
                  ELSE cs.payment_status
                END,
                current_route_state = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM admin_enrollments ae
                     WHERE ae.checkout_id = cs.checkout_id
                       AND ae.status NOT IN ('confirmed','active','cancelled','refunded')
                  ) THEN 'paid'
                  ELSE cs.current_route_state
                END,
                updated_at = NOW()
          WHERE cs.checkout_id = $1`,
        [cur.rows[0].checkout_id]
      );
    }

    // U10 修補：團報對帳通過 → 回寫該成員 group_order_members.payment_confirmed。
    //   家長端團報狀態頁（GroupStatusPage 讀 group_order_members.payment_confirmed）原本只認
    //   payment_proof_url（顯示「已上傳，待確認」），但對帳只動 admin_enrollments.status，
    //   兩者從未同步 → 成員永遠卡「待確認」。這裡以 (group_order_id, parent_id) 對應成員
    //   （parent_id 由報名手機反查，與 ensureGroupCoursePeriod 一致），對帳成功時標記為已確認。
    //   一般報名（group_order_id 為 NULL）不受影響；payment_confirmed=FALSE 守門確保冪等。
    if (cur.rows[0].group_order_id) {
      const gconf = await client.query(
        `UPDATE group_order_members gom
            SET payment_confirmed = TRUE,
                payment_confirmed_at = NOW(),
                payment_confirmed_by = $3
          FROM parents p
          WHERE p.id = gom.parent_id
            AND gom.group_order_id = $1
            AND p.phone = $2
            AND gom.payment_confirmed = FALSE`,
        [cur.rows[0].group_order_id, cur.rows[0].parent_phone, String(by).slice(0, 50)]
      );
      if (!gconf.rowCount) {
        console.warn('[reconcile/group] 對帳通過但未回寫 payment_confirmed（找不到對應成員或已是已確認）:',
          cur.rows[0].id, 'group:', cur.rows[0].group_order_id);
      } else {
        await logGroupOrderAudit(client, {
          groupOrderId: cur.rows[0].group_order_id,
          action: `櫃檯確認帳款（${cur.rows[0].parent_name}／${cur.rows[0].parent_phone}，報名 ${cur.rows[0].id} 對帳通過，發票 ${invoiceNumber}）`,
          by,
        });
      }
    }

    // ── U9 團報橋：對帳通過＝v7「立即自動開通」→ 為團報 get-or-create 一個共用 course_period，
    //    並把本成員的學員加入 course_period_enrollments，教練端課表（讀 course_periods/sessions）才看得到。
    //    僅針對團報（group_order_id 有值）；一般報名維持原行為（不在本任務範圍）。
    await ensureGroupCoursePeriod(client, cur.rows[0], total);
    // U11 一般報名橋：非團報對帳通過也自動開通 course_period（補回家長/教練/聊天室/學習歷程
    // 讀正式課期的缺口）。與上方團報橋以 group_order_id 守門互斥，不重複建。
    const reconcileCreatedStudentIds = (await ensureSoloCoursePeriod(client, cur.rows[0], total)) || [];

    // 家長通知信排進 outbox（COMMIT 前，理由同 checkouts.js）。
    // 這支是 legacy 單筆入口，等同 checkout 版 N=1 的退化情形。
    const venueNameRow = await client.query(`SELECT name FROM admin_venues WHERE id = $1`, [cur.rows[0].venue_id]);
    const mailOutboxId = await enqueueReconcileMail(client, {
      refId: String(id),
      orders: [cur.rows[0]],
      invoice: { invoiceNumber, invoiceImageUrl, amount: cur.rows[0].final_price },
      venueId: cur.rows[0].venue_id,
      venueName: venueNameRow.rows[0]?.name || cur.rows[0].venue_id,
      parentPhone: cur.rows[0].parent_phone,
      parentName: cur.rows[0].parent_name,
    });

    await client.query('COMMIT');

    // get-or-create 出來的新學員 → 即時回寫 Ragic（best-effort、fire-and-forget）；
    // 新列 last_synced_at 預設 NULL，回寫失敗由每日備份排程重試。
    if (reconcileCreatedStudentIds.length) {
      ragicWriteback.scheduleWriteback({ studentIds: reconcileCreatedStudentIds, reason: 'enrollment-reconcile' });
    }

    // 對帳通過 = 等同此筆轉「進行中」→ 立即補對應 course_period 的 chat_room
    try {
      const chatRooms = require('../../services/chatRooms');
      await chatRooms.backfillRoomsForActivePeriods();
    } catch (e) {
      console.warn('[reconcile] backfill chat rooms failed:', e.message);
    }

    // 家長端改走 Email（Owner 決定：家長不用 LINE）。
    await deliverOutbox([mailOutboxId]);

    res.json(await readEnrollment(id));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/enrollments/:id/reconcile]', err);
    res.status(500).json({ error: 'reconcile failed' });
  } finally {
    client.release();
  }
});

/**
 * @param {string} id
 * @param {number|null} feeRateOverride 0–1 的比率。給了就用它算，沒給就用全域設定。
 *   Owner 2026-08-12 決定手續費率可由櫃檯逐筆調整（下拉預設值＋可自填）。
 *   偏離全域設定時，退費端點會把「原定 X% → 實用 Y%」寫進 audit log。
 */
async function computeRefundPreview(id, feeRateOverride = null) {
  const enrollment = await readEnrollment(id);
  if (!enrollment) return null;
  const settings = await getSettings();
  const default_fee_rate = settings.refund_fee_rate ?? 0.1;
  const override = normalizeFeeRate(feeRateOverride);
  const fee_rate = override === null ? default_fee_rate : override;

  // U12 家庭共班退費＝「整班整期」處理（營運規則：不會有單一小孩中途退出）。
  // 此報名若屬共用 period（同批同期多筆兄弟訂單、period 掛 enrollment_batch_id），
  // 預覽與退費都以本期「全部兄弟訂單」為單位：
  //   - 已用堂數＝共用 period 有簽到的堂（DISTINCT session，班級層級，同堂多孩不重複計）
  //   - 退款＝各兄弟訂單 final_price 按同一剩餘比例逐筆計算後加總（逐筆入庫，帳能對回發票）
  // 試上單防禦：試上訂單也帶 enrollment_batch_id，但其 period 由 solo 分支建立（不寫 batch id）。
  // 目前查詢會自然落空 fallthrough，但為避免未來 trial period 也寫 batch id 時誤入整批退費，
  // 明確以 order_kind 排除（試上一律走下方單筆比例公式）。
  if (!enrollment.group_order_id && enrollment.enrollment_batch_id && enrollment.order_kind !== 'trial') {
    const sp = await pool.query(
      `SELECT cp.id, cp.total_sessions,
              (SELECT COUNT(DISTINCT cs.id)::int
                 FROM course_sessions cs
                 JOIN checkin_records cr ON cr.course_session_id = cs.id
                WHERE cs.course_period_id = cp.id
                  AND cs.status::text NOT LIKE 'cancelled%'
                  AND cr.attendance_status = 'ATTENDED') AS used_sessions
         FROM course_periods cp
        WHERE cp.enrollment_batch_id = $1 AND cp.period_number = $2
        LIMIT 1`,
      [enrollment.enrollment_batch_id, enrollment.period_number || 1]
    );
    if (sp.rowCount) {
      const siblings = await pool.query(
        `SELECT id, final_price::float8 AS final_price
           FROM admin_enrollments
          WHERE enrollment_batch_id = $1 AND COALESCE(period_number, 1) = $2
            AND group_order_id IS NULL AND status NOT IN ('cancelled','refunded')
          ORDER BY submitted_at, id`,
        [enrollment.enrollment_batch_id, enrollment.period_number || 1]
      );
      // 只要共用 period 存在（有 enrollment_batch_id 就是共班），退費一律整期處理；
      // rowCount 可能因舊版部署期間的單筆退費而少於原班人數，剩幾筆就整批退幾筆。
      if (siblings.rowCount >= 1) {
        const total = sp.rows[0].total_sessions || settings.sessions_per_period || 6;
        const used = sp.rows[0].used_sessions || 0;
        const remainRatio = Math.max(0, (total - used) / total);
        const sibling_refunds = siblings.rows.map((row) => ({
          id: row.id,
          final_price: Number(row.final_price) || 0,
          refund_amount: Math.round(Number(row.final_price) * remainRatio * (1 - fee_rate)),
        }));
        return {
          enrollment, total, used, remainRatio, fee_rate, default_fee_rate,
          refund_amount: sibling_refunds.reduce((sum, row) => sum + row.refund_amount, 0),
          family_shared: true,
          course_period_id: sp.rows[0].id,
          sibling_refunds,
          sibling_ids: sibling_refunds.map((row) => row.id),
          batch_final_price: sibling_refunds.reduce((sum, row) => sum + row.final_price, 0),
        };
      }
    }
  }

  const total = enrollment.total_sessions || settings.sessions_per_period || 6;
  const used = enrollment.used_sessions || 0;
  const remainRatio = Math.max(0, (total - used) / total);
  const refund_amount = Math.round(enrollment.final_price * remainRatio * (1 - fee_rate));
  // default_fee_rate 一併回傳：前端要能顯示「原定 10%」，也才能判斷這次有沒有被調過。
  return { enrollment, total, used, remainRatio, fee_rate, default_fee_rate, refund_amount };
}

// 退費試算與執行都開放 staff（櫃檯）。兩支必須一起開 —— 只開 refund 不開 preview 的話
// 櫃檯打得開頁面但看不到試算金額，等於功能沒開。
router.get('/:id/refund-preview', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  try {
    // ?fee_rate= 讓櫃檯調整手續費率後即時重算金額。不合法的值（非數字、負數、>1）
    // 由 normalizeFeeRate 回 null，等同沒給 → 退回全域設定，不會算出負的退款。
    const preview = await computeRefundPreview(req.params.id, req.query.fee_rate);
    if (!preview) return res.status(404).json({ error: 'enrollment not found' });
    if (!isVenueInScope(req, preview.enrollment.venue_id)) {
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
    }
    res.json(preview);
  } catch (err) {
    console.error('[admin/enrollments/:id/refund-preview]', err);
    res.status(500).json({ error: 'preview failed' });
  }
});

router.post('/:id/refund', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const body = req.body || {};

    // ── 申請原因：分類（必填、白名單）＋ 詳述（必填）──
    // Owner 2026-08-12 對齊 Ragic 表單。分類讓退費原因可彙總，詳述保留現場細節。
    // 舊呼叫端只送 reason 一個字串，仍然接受（否則部署期間新舊前端交錯會全部退不了）。
    const category = String(body.reason_category || '').trim();
    const detail = String(body.reason_detail || '').trim();
    const legacyReason = String(body.reason || '').trim();

    if (category) {
      if (!REFUND_REASON_CODES.includes(category)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '申請原因不在允許清單內' });
      }
      if (!detail) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '詳述原因必填' });
      }
    } else if (!legacyReason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '請選擇申請原因並填寫詳述' });
    }

    // 寫進 audit log 的那一行：分類與詳述併成人看得懂的一句，
    // 之後要拆回來統計時 label 前綴是穩定的。
    const reason = category ? `${refundReasonLabel(category)}｜${detail}` : legacyReason;

    const by = (req.body && req.body.by) || req.adminUser?.name || req.adminUser?.username || 'unknown';

    // ── 手續費率覆寫 ──
    // 櫃檯可逐筆調整（Owner 決定：下拉預設值＋可自填）。這會直接改變退款金額，
    // 所以偏離全域設定時一定要在 audit log 留下痕跡與操作者。
    const feeOverride = normalizeFeeRate(body.fee_rate);
    const preview = await computeRefundPreview(id, feeOverride);
    // 手續費率被調過時，audit log 的 action 要看得出「原定多少、實際用多少」。
    // 只比對 preview 回來的兩個值，不信任前端送的數字。
    const pct = (r) => `${Math.round(Number(r) * 1000) / 10}%`;
    const feeNote = preview && preview.fee_rate !== preview.default_fee_rate
      ? `，手續費率 ${pct(preview.default_fee_rate)} → ${pct(preview.fee_rate)}（由 ${by} 調整）`
      : '';
    if (!preview) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'enrollment not found' });
    }
    if (!isVenueInScope(req, preview.enrollment.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
    }
    if (['refunded', 'cancelled'].includes(preview.enrollment.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `狀態 ${preview.enrollment.status} 的報名不可退費` });
    }

    if (preview.family_shared) {
      // U12 家庭共班：退費一律「整班整期」——本期全部兄弟訂單同交易一起退，
      // 共用 period 轉 refunded、未來未上課的課堂取消並釋出教練時段。
      // 不支援退單一小孩（營運規則：不會有單一小孩中途退出）。
      // FOR UPDATE 鎖住全批兄弟訂單：並發重複退費會 block 到前一筆 COMMIT，
      // 重讀後已退的列被剔除，不會二次入帳。
      const locked = await client.query(
        `SELECT id, status FROM admin_enrollments WHERE id = ANY($1::text[]) FOR UPDATE`,
        [preview.sibling_ids]
      );
      const refundable = new Set(
        locked.rows
          .filter((row) => !['refunded', 'cancelled'].includes(row.status))
          .map((row) => row.id)
      );
      if (!refundable.size) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '本期兄弟訂單皆已退費/取消，無可退項目' });
      }
      const applied = preview.sibling_refunds.filter((row) => refundable.has(row.id));
      const appliedTotal = applied.reduce((sum, row) => sum + row.refund_amount, 0);
      for (const sib of applied) {
        await client.query(
          `UPDATE admin_enrollments SET status = 'refunded', refund_amount = $2, refunded_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [sib.id, sib.refund_amount]
        );
        await promotions.revertUsage({ adminEnrollmentId: sib.id }, client);
        await client.query(
          `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason, refund_amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [sib.id,
           `退課（家庭共班整期退費，理由：${reason}，本筆退款 NT$ ${sib.refund_amount.toLocaleString()}，整期合計 NT$ ${appliedTotal.toLocaleString()}${feeNote}）`,
           by, reason, sib.refund_amount]
        );
      }
      // 釋出未來已排課堂占用的教練時段，再取消課堂（已上完的課保留紀錄）。
      await client.query(
        `UPDATE coach_availability_slots
            SET status = 'available', booked_session_id = NULL, updated_at = NOW()
          WHERE booked_session_id IN (
            SELECT id FROM course_sessions
             WHERE course_period_id = $1 AND scheduled_at > NOW()
               AND status IN ('confirmed','pending_group_confirm'))`,
        [preview.course_period_id]
      );
      await client.query(
        `UPDATE course_sessions
            SET status = 'cancelled_normal', cancelled_at = NOW(), updated_at = NOW()
          WHERE course_period_id = $1 AND scheduled_at > NOW()
            AND status IN ('confirmed','pending_group_confirm')`,
        [preview.course_period_id]
      );
      await client.query(
        `UPDATE course_periods SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
        [preview.course_period_id]
      );
      await client.query('COMMIT');

      const updated = await readEnrollment(id);
      return res.json({
        ...updated,
        refund_amount: appliedTotal,
        family_shared: true,
        refunded_enrollment_ids: applied.map((row) => row.id),
        sibling_refunds: applied,
      });
    }

    await client.query(
      `UPDATE admin_enrollments SET status = 'refunded', refund_amount = $2, refunded_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id, preview.refund_amount]
    );
    // 退費即釋放此報名占用的優惠用量（同交易內，以 admin_enrollment_id 冪等；無 usage 則 no-op）。
    await promotions.revertUsage({ adminEnrollmentId: id }, client);
    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason, refund_amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, `退課（理由：${reason}，退款 NT$ ${preview.refund_amount.toLocaleString()}${feeNote}）`, by, reason, preview.refund_amount]
    );
    await client.query('COMMIT');

    const updated = await readEnrollment(id);
    res.json({ ...updated, refund_amount: preview.refund_amount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/enrollments/:id/refund]', err);
    res.status(500).json({ error: 'refund failed' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/enrollments/:id/cancel  — F-M02 待對帳清單的「取消」操作
 * 僅能取消仍在待對帳（pending_payment）狀態的報名；已對帳/已退費/已取消不可重複取消。
 */
router.post('/:id/cancel', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const reason = (req.body && req.body.reason || '').trim();
    const by = (req.body && req.body.by) || req.adminUser?.name || req.adminUser?.username || 'unknown';

    const cur = await client.query(`SELECT * FROM admin_enrollments WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'enrollment not found' });
    }
    if (!isVenueInScope(req, cur.rows[0].venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
    }
    if (cur.rows[0].status !== 'pending_payment') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `狀態 ${cur.rows[0].status} 的報名不可取消` });
    }

    await client.query(
      `UPDATE admin_enrollments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    if (cur.rows[0].checkout_id) {
      await client.query(
        `UPDATE checkout_sessions cs
            SET payment_status = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM admin_enrollments ae
                     WHERE ae.checkout_id = cs.checkout_id
                       AND ae.id <> $2
                       AND ae.status <> 'cancelled'
                  ) THEN 'cancelled'
                  ELSE cs.payment_status
                END,
                current_route_state = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM admin_enrollments ae
                     WHERE ae.checkout_id = cs.checkout_id
                       AND ae.id <> $2
                       AND ae.status <> 'cancelled'
                  ) THEN 'cancelled'
                  ELSE cs.current_route_state
                END,
                updated_at = NOW()
          WHERE cs.checkout_id = $1`,
        [cur.rows[0].checkout_id, id]
      );
    }
    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason)
       VALUES ($1, $2, $3, $4)`,
      [id, reason ? `取消報名（原因：${reason}）` : '取消報名', by, reason || null]
    );
    await client.query('COMMIT');

    res.json(await readEnrollment(id));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/enrollments/:id/cancel]', err);
    res.status(500).json({ error: 'cancel failed' });
  } finally {
    client.release();
  }
});

// ── POST /:id/return-for-fix 退回補件（U14）──────────────────
// 與 /cancel 的差別：
//   cancel         → cancelled（終態，家長無法續作）— 行為完全不變
//   return-for-fix → pending_payment（可續作）— 家長回去補付款資料後繼續完成
// 兩種入口都支援：
//   ① 單還在 pending_payment、但付款資料有問題 → 清空供重填
//   ② 單已被 cancelled → 復活回 pending_payment（使用者訴求的「不要直接刪掉」）
// 清空付款欄位是必要的：courses.js 的 payment-proof 對「末 5 碼＋證明皆已送出」
// 是鎖死的（PAYMENT_LOCKED），不清空家長改不了。
// 付款資料屬 checkout 層級（見 courses.js payment-proof 的 updateEnrollmentWhere），
// 故有 checkout_id 時一併把該 checkout 的付款欄位與狀態退回。
router.post('/:id/return-for-fix', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim() : '';
  if (!reason) return res.status(400).json({ error: '請填寫退回原因', code: 'REASON_REQUIRED' });
  const by = req.adminUser?.name || req.adminUser?.username || 'unknown';

  const client = await pool.connect();
  let notify = null;
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT * FROM admin_enrollments WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'enrollment not found' });
    }
    const row = cur.rows[0];
    if (!isVenueInScope(req, row.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
    }
    // 已對帳成立（confirmed）或已退費的單不可退回補件——那要走退費流程，不是補件。
    if (!['pending_payment', 'cancelled'].includes(row.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `狀態 ${row.status} 的報名不可退回補件`, code: 'NOT_RETURNABLE',
      });
    }

    await client.query(
      `UPDATE admin_enrollments
          SET status = 'pending_payment',
              cancel_reason = $2, returned_at = NOW(), returned_by = $3,
              payment_proof_url = NULL, transfer_last_5 = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, reason, by]
    );
    if (row.checkout_id) {
      await client.query(
        `UPDATE checkout_sessions
            SET payment_status = 'pending_payment',
                current_route_state = 'pending_payment',
                payment_proof_url = NULL, transfer_last_5 = NULL,
                updated_at = NOW()
          WHERE checkout_id = $1`,
        [row.checkout_id]
      );
    }
    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason)
       VALUES ($1, $2, $3, $4)`,
      [row.id, `退回補件（原狀態 ${row.status} → pending_payment，付款資料已清空供重填）`, by, reason]
    );

    const p = await client.query(
      `SELECT line_uid FROM parents WHERE phone = $1 AND line_uid IS NOT NULL LIMIT 1`,
      [row.parent_phone]
    );
    notify = { uid: p.rows[0]?.line_uid || null, venueId: row.venue_id, enrollmentId: row.id };

    await client.query('COMMIT');
    res.json(await readEnrollment(row.id));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[admin/enrollments/:id/return-for-fix]', { code: err?.code || 'UNEXPECTED' });
    return res.status(500).json({ error: '退回補件失敗' });
  } finally {
    client.release();
  }

  // best-effort 通知家長（交易外；失敗只記 log，不影響已落地的退回結果）
  // line 沿用本檔既有的 lazy require 慣例（見 reconcile 內），不動模組載入順序。
  if (notify && notify.uid) {
    const line = require('../../services/line');
    const liffUrl = `${process.env.LIFF_URL_PARENT || process.env.LIFF_URL || 'https://liff.line.me/-'}/enroll-status/${notify.enrollmentId}`;
    line.pushMessage(notify.uid, line.templates.returnedForFix({
      title: '您的報名已退回補件',
      reason,
      hint: '原本的轉帳末 5 碼與匯款證明已清空，請重新填寫並上傳。',
      liffUrl,
    }), notify.venueId).catch((e) => console.warn('[enrollment return-for-fix push]', e.message));
  }
});

router._checkoutInternals = {
  getSettings,
  ensureGroupCoursePeriod,
  ensureSoloCoursePeriod,
};
router._lineProfileInternals = { readEnrollment };

module.exports = router;
