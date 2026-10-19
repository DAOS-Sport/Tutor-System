'use strict';
// 對帳通過後開通課期（course_period）的共用邏輯。原本住在 routes/admin/enrollments.js，
// 由 routes/admin/checkouts.js 透過 router._checkoutInternals 借用；#36 原樣搬出成 service，函式內容逐字未改。
const { pool } = require('../models/db');
const { writeStudentAudit } = require('./studentAudit');
const { getCourseConfig } = require('./courseConfig');

// A shared period can only carry a purchase coefficient when every source
// order has the same explicit snapshot.  Missing/mixed legacy evidence stays
// NULL; amounts and the coach's current profile are intentionally ignored.
function commonPurchasedMultiplier(rows) {
  const values = (rows || []).map((row) => {
    if (row?.purchased_pricing_multiplier === null || row?.purchased_pricing_multiplier === undefined) return null;
    const value = Number(row.purchased_pricing_multiplier);
    return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null;
  });
  if (!values.length || values.some((value) => value === null)) return null;
  return values.every((value) => value === values[0]) ? values[0] : null;
}

async function getSettings(db = pool) {
  const r = await db.query(`SELECT key, value FROM admin_settings`);
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
    `SELECT id, status, original_price, final_price, checkout_id, enrollment_batch_id, purchased_pricing_multiplier
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
  const groupOriginalPrice = confirmed.reduce((sum, row) => sum + (Number(row.original_price) || 0), 0);
  const groupTotalPrice = confirmed.reduce((sum, row) => sum + (Number(row.final_price) || 0), 0)
    || (Number(enrollment.final_price) || 0);
  const purchasedMultiplier = commonPurchasedMultiplier(confirmed);

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
          expires_at, original_price, final_price, status, admin_enrollment_id, group_order_id, period_number,
          purchased_pricing_multiplier)
       VALUES ($1,$2,$3,$4,0,(NOW() + ($5 || ' days')::interval)::date,$6,$11,'active',$7,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        enrollment.coach_id, enrollment.venue_id, enrollment.course_type, totalSessions,
        String(365 * (Number(enrollment.period_count) || 1)),
        groupOriginalPrice, enrollment.id, groupOrderId, periodNumber, purchasedMultiplier, groupTotalPrice,
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
async function ensureSoloCoursePeriod(client, enrollment, totalSessions, auditActor = { byUser: 'system:enrollment-reconcile', byRole: 'system' }) {
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
  // 試上比照正式課（使用者 2026-10-14）：家長端試上訂單每人每堂一筆、period_number＝第幾堂，
  // 同批同堂的兄弟訂單同樣開成一個共用體驗課期（一起上、一起簽到、教練計 1 堂）。
  const periodNumber = Number(enrollment.period_number) || 1;
  const isTrialOrder = enrollment.order_kind === 'trial';
  let siblingRows = null; // 非 null＝共用 period 模式（含本筆在內、本期全部有效兄弟訂單）
  if (enrollment.enrollment_batch_id) {
    const sib = await client.query(
      `SELECT id, students, student_ids, status, original_price, final_price, purchased_pricing_multiplier
         FROM admin_enrollments
        WHERE enrollment_batch_id = $1
          AND period_number = $2
          AND group_order_id IS NULL
          AND status NOT IN ('cancelled','refunded')
        ORDER BY submitted_at, id`,
      [enrollment.enrollment_batch_id, periodNumber]
    );
    if (sib.rowCount > 1) {
      // F-A08：共班判定要用「這筆報名的場館所屬定價區」的設定。
      // 這裡刻意不吞例外：課別被從該區刪掉時，靜默當成 1 人會把共用課期建成獨立課期，
      // 之後簽到扣課全部錯位，而且完全看不出來。寧可讓對帳停下來、把設定補回去。
      const cfgRow = await getCourseConfig(client, {
        venueId: enrollment.venue_id,
        courseType: enrollment.course_type,
      });
      if ((Number(cfgRow.max_students) || 1) > 1) {
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
      const purchasedMultiplier = commonPurchasedMultiplier(siblingRows);
      // 試上共用課期沿用單人試上的契約：體驗標記＋效期 30 天（政策 2026-07-16）。
      const ins = await client.query(
        `INSERT INTO course_periods
           (coach_id, venue_id, course_type, total_sessions, used_sessions,
            expires_at, original_price, final_price, status, admin_enrollment_id,
            enrollment_batch_id, period_number, purchased_pricing_multiplier, is_experience_course)
         VALUES ($1,$2,$3,$4,0,(NOW() + ($5 || ' days')::interval)::date,$6,$7,'active',$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          coachId, enrollment.venue_id, enrollment.course_type, totalSessions,
          isTrialOrder ? '30' : String(365 * (Number(enrollment.period_count) || 1)),
          originalSum, finalSum,
          siblingRows[0].id, enrollment.enrollment_batch_id, periodNumber, purchasedMultiplier,
          isTrialOrder,
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
      // period_number 必須跟著報名單走。這欄是 NOT NULL DEFAULT 1，漏帶不會報錯，
      // 只會讓第 2 期以後的課期全部被標成「第 1 期」（2026-08-21 盤點：51 筆）。
      // 團報（L188）與兄弟共用（L373）兩條路徑本來就有帶，只有這條單人路徑漏了。
      // 影響不只報表：course_periods 有 UNIQUE(enrollment_batch_id, period_number)，
      // 而 usageSync／deductionRevival 也用 (batch, period_number) 反查訂單。
      // 目前這條路徑不寫 enrollment_batch_id 所以還沒撞到，但值錯著就是個地雷。
      const ins = await client.query(
        `INSERT INTO course_periods
           (coach_id, venue_id, course_type, total_sessions, used_sessions,
            expires_at, original_price, final_price, status, admin_enrollment_id, is_experience_course,
            period_number, purchased_pricing_multiplier)
         VALUES ($1,$2,$3,$4,0,(NOW() + ($5 || ' days')::interval)::date,$6,$7,'active',$8,$9,$10,$11)
         RETURNING id`,
        [
          coachId, enrollment.venue_id, enrollment.course_type, totalSessions,
          validityDays,
          Number(enrollment.original_price) || 0, Number(enrollment.final_price) || 0,
          enrollment.id, enrollment.order_kind === 'trial', periodNumber,
          commonPurchasedMultiplier([enrollment]),
        ]
      );
      periodId = ins.rows[0]?.id || null;
    }
  }
  if (!periodId) return createdStudentIds;

  // 綁學員進 course_period_enrollments。共用 period 模式：綁「本期全部兄弟訂單」的學員。
  // 新訂單記有實際學員 id（admin_enrollments.student_ids，家庭帳號時可能是家人名下的孩子）→ 直接用；
  // 舊訂單沒有 id → 沿用（parent_id + name）get-or-create。
  const orderRows = siblingRows || [enrollment];
  const knownIds = [...new Set(orderRows.flatMap((row) => (Array.isArray(row.student_ids) ? row.student_ids : [])).map(String))];
  if (knownIds.length) {
    const existing = await client.query(`SELECT id FROM students WHERE id = ANY($1::uuid[])`, [knownIds]);
    for (const row of existing.rows) {
      await client.query(
        `INSERT INTO course_period_enrollments (course_period_id, student_id, status)
         VALUES ($1, $2, 'active') ON CONFLICT (course_period_id, student_id) DO NOTHING`,
        [periodId, row.id]
      );
    }
    if (existing.rowCount !== knownIds.length) {
      console.warn('[reconcile/solo] 訂單記載的學員有已不存在者，略過：', enrollment.id);
    }
  }
  const names = [...new Set(orderRows
    .filter((row) => !(Array.isArray(row.student_ids) && row.student_ids.length))
    .flatMap((row) => row.students || [])
    .filter(Boolean))];
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
      await writeStudentAudit(client, sid, 'create', { ...auditActor, note: 'enrollment-reconcile-student-create' });
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

module.exports = { getSettings, ensureGroupCoursePeriod, ensureSoloCoursePeriod, commonPurchasedMultiplier };
