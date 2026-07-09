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
const ragicWriteback = require('../../services/ragicWriteback');
const promotions = require('../../services/promotions');
const {
  createCheckoutSession,
} = require('../../services/checkouts');

const router = express.Router();

// 一期固定 6 堂；手動建檔總堂數 > 6 → 依 ceil(N/6) 拆成多張訂單（每張一期）。
const SESSIONS_PER_PERIOD = 6;

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

  // 團報金流守門：同一個 enrollment_batch_id 代表同一團報購買批次；
  // 但 checkout 以 parent_id 隔離成多張母單。只有該批次所有有效 checkout 都 paid，
  // 才能正式開通團報課程，避免 A 家長對帳通過時直接開通 B 家長尚未付清的課。
  const batchId = enrollment.enrollment_batch_id || relevant.find((row) => row.enrollment_batch_id)?.enrollment_batch_id || null;
  if (batchId) {
    const pay = await client.query(
      `SELECT cs.checkout_id, cs.payment_status
         FROM checkout_sessions cs
        WHERE cs.enrollment_batch_id = $1
          AND EXISTS (
            SELECT 1 FROM admin_enrollments ae
             WHERE ae.checkout_id = cs.checkout_id
               AND ae.group_order_id = $2
               AND ae.status NOT IN ('cancelled','refunded')
          )`,
      [batchId, groupOrderId]
    );
    const unpaid = pay.rows.filter((row) => row.payment_status !== 'paid');
    if (!pay.rowCount || unpaid.length > 0) {
      console.warn(
        '[reconcile/group] 團報 batch 尚未全數 checkout paid，暫不建立課程:',
        'group:', groupOrderId,
        'batch:', batchId,
        'unpaid:', unpaid.map((row) => `${row.checkout_id}:${row.payment_status}`).join(',') || '(none)'
      );
      return;
    }
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

  // get-or-create「本期」共用 period（並發對帳同團同期多筆時，ON CONFLICT 收斂到同一個 period）
  const ins = await client.query(
    `INSERT INTO course_periods
       (coach_id, venue_id, course_type, total_sessions, used_sessions,
        expires_at, original_price, final_price, status, admin_enrollment_id, group_order_id, period_number)
     VALUES ($1,$2,$3,$4,0,(NOW() + ($5 || ' days')::interval)::date,$6,$6,'active',$7,$8,$9)
     ON CONFLICT (group_order_id, period_number) WHERE group_order_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      enrollment.coach_id, enrollment.venue_id, enrollment.course_type, totalSessions,
      String(365 * (Number(enrollment.period_count) || 1)),
      groupTotalPrice, enrollment.id, groupOrderId, periodNumber,
    ]
  );
  let periodId = ins.rows[0]?.id;
  if (!periodId) {
    const ex = await client.query(
      `SELECT id FROM course_periods WHERE group_order_id = $1 AND period_number = $2`,
      [groupOrderId, periodNumber]
    );
    periodId = ex.rows[0]?.id || null;
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

  // get-or-create course_period（以 admin_enrollment_id 冪等；一般報名 group_order_id 為 NULL）
  const exist = await client.query(
    `SELECT id FROM course_periods WHERE admin_enrollment_id = $1 AND group_order_id IS NULL LIMIT 1`,
    [enrollment.id]
  );
  let periodId = exist.rows[0]?.id || null;
  if (!periodId) {
    const ins = await client.query(
      `INSERT INTO course_periods
         (coach_id, venue_id, course_type, total_sessions, used_sessions,
          expires_at, original_price, final_price, status, admin_enrollment_id)
       VALUES ($1,$2,$3,$4,0,(NOW() + ($5 || ' days')::interval)::date,$6,$7,'active',$8)
       RETURNING id`,
      [
        coachId, enrollment.venue_id, enrollment.course_type, totalSessions,
        String(365 * (Number(enrollment.period_count) || 1)),
        Number(enrollment.original_price) || 0, Number(enrollment.final_price) || 0,
        enrollment.id,
      ]
    );
    periodId = ins.rows[0]?.id || null;
  }
  if (!periodId) return createdStudentIds;

  // get-or-create 學員（以 parent_id + name）→ 綁進 course_period_enrollments
  const names = (enrollment.students || []).filter(Boolean);
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
  // 取「YYYY-MM-DDTHH:mm:ss」格式（不含 ms / timezone），與 mock 行為對齊
  const iso = new Date(d).toISOString();
  return iso.slice(0, 19);
}

async function readEnrollment(id) {
  const e = await pool.query(
    `SELECT ae.*, au.name AS created_by_name
       FROM admin_enrollments ae
       LEFT JOIN admin_users au ON au.id = ae.created_by
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
  return {
    id: row.id,
    parent_name: row.parent_name,
    parent_phone: row.parent_phone,
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
    invoice_url: row.invoice_url || null,
    invoice_issued_at: tsToString(row.invoice_issued_at),
    extra_parent_phones: row.extra_parent_phones || [],
    notes: row.notes || null,
    group_order_id: row.group_order_id || null,
    is_group_shared: !!row.is_group_shared,
    period_count: Number(row.period_count) || 1,
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
    console.error('[admin/enrollments create]', err);
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
    const total = perPeriod * periodCount;

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
           (checkout_id, order_id, buyer_name, amount, invoice_number, invoice_image_url, invoice_url, issued_at)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (checkout_id) WHERE order_id IS NULL
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
      }
    }

    // ── U9 團報橋：對帳通過＝v7「立即自動開通」→ 為團報 get-or-create 一個共用 course_period，
    //    並把本成員的學員加入 course_period_enrollments，教練端課表（讀 course_periods/sessions）才看得到。
    //    僅針對團報（group_order_id 有值）；一般報名維持原行為（不在本任務範圍）。
    await ensureGroupCoursePeriod(client, cur.rows[0], total);
    // U11 一般報名橋：非團報對帳通過也自動開通 course_period（補回家長/教練/聊天室/學習歷程
    // 讀正式課期的缺口）。與上方團報橋以 group_order_id 守門互斥，不重複建。
    const reconcileCreatedStudentIds = (await ensureSoloCoursePeriod(client, cur.rows[0], total)) || [];

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

    // Task #39：推播 LINE Flex 發票通知給家長（含課程資訊）
    try {
      const line = require('../../services/line');
      const enrollment = cur.rows[0];
      const parentPhone = enrollment.parent_phone;
      if (parentPhone) {
        const parentRow = await pool.query(
          `SELECT line_uid FROM parents WHERE phone = $1`, [parentPhone]
        );
        const lineUid = parentRow.rows[0]?.line_uid;
        if (lineUid) {
          const publicBase = (process.env.PUBLIC_BASE_URL || process.env.ADMIN_URL || '').replace(/\/$/, '');
          const absoluteImageUrl = invoiceImageUrl.startsWith('http')
            ? invoiceImageUrl
            : `${publicBase}${invoiceImageUrl}`;
          const liffUrl = process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '';
          // 查場館名稱
          let venueName = enrollment.venue_id;
          try {
            const vRow = await pool.query(`SELECT name FROM admin_venues WHERE id = $1`, [enrollment.venue_id]);
            if (vRow.rows[0]) venueName = vRow.rows[0].name;
          } catch (_) { /* best-effort */ }
          // 組別中文
          const ctMap = { 1: '1 對 1', 2: '1 對 2', 3: '1 對 3' };
          const courseTypeLabel = ctMap[enrollment.course_type] || `1 對 ${enrollment.course_type}`;
          const messages = line.templates.invoiceIssued({
            parentName: enrollment.parent_name,
            invoiceNumber,
            invoiceImageUrl: absoluteImageUrl,
            invoiceUrl: invoiceUrl || null,
            coachName: enrollment.coach,
            venueName,
            courseType: courseTypeLabel,
            finalPrice: enrollment.final_price,
            liffUrl,
          });
          await line.pushMessage(lineUid, messages, enrollment.venue_id);
        }
      }
    } catch (e) {
      console.warn('[reconcile] LINE push invoice failed:', e.message);
    }

    res.json(await readEnrollment(id));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/enrollments/:id/reconcile]', err);
    res.status(500).json({ error: 'reconcile failed' });
  } finally {
    client.release();
  }
});

async function computeRefundPreview(id) {
  const enrollment = await readEnrollment(id);
  if (!enrollment) return null;
  const settings = await getSettings();
  const total = enrollment.total_sessions || settings.sessions_per_period || 6;
  const used = enrollment.used_sessions || 0;
  const remainRatio = Math.max(0, (total - used) / total);
  const fee_rate = settings.refund_fee_rate ?? 0.1;
  const refund_amount = Math.round(enrollment.final_price * remainRatio * (1 - fee_rate));
  return { enrollment, total, used, remainRatio, fee_rate, refund_amount };
}

router.get('/:id/refund-preview', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const preview = await computeRefundPreview(req.params.id);
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

router.post('/:id/refund', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const reason = (req.body && req.body.reason || '').trim();
    if (!reason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '退課理由必填' });
    }
    const by = (req.body && req.body.by) || req.adminUser?.name || req.adminUser?.username || 'unknown';

    const preview = await computeRefundPreview(id);
    if (!preview) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'enrollment not found' });
    }
    if (!isVenueInScope(req, preview.enrollment.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此報名不在您的場館範圍內' });
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
      [id, `退課（理由：${reason}，退款 NT$ ${preview.refund_amount.toLocaleString()}）`, by, reason, preview.refund_amount]
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

router._checkoutInternals = {
  getSettings,
  ensureGroupCoursePeriod,
  ensureSoloCoursePeriod,
};

module.exports = router;
