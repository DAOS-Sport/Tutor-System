// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔凍結範圍：/lessons、/mine、/:id 的簽到方姓名揭露（checked_in_by_name / partner_checkin_name，僅團報期、僅姓名）。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
/**
 * 家長端課程查詢 (F-S07 上課記錄)
 *   GET /api/courses/lessons   登入家長的所有上課記錄（含已簽到）
 */
const express = require('express');
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const { parseProofInput } = require('../services/paymentProof');
const { partnerCheckinLabel } = require('../services/groupPartner');
const promotions = require('../services/promotions');

const router = express.Router();

router.get('/lessons', requireParent, async (req, res) => {
  try {
    // F-S07 篩選：from / to (日期) / coachId / courseType (1對1=group, 1對2..)
    const args = [req.parent.id];
    const conds = [
      `s.parent_id = $1`,
      `cpe.status = 'active'`,
      `cs.status IN ('confirmed','completed','pending_group_confirm')`,
    ];
    if (req.query.from) {
      args.push(req.query.from);
      conds.push(`cs.scheduled_at >= ($${args.length}::date::timestamp AT TIME ZONE 'Asia/Taipei')`);
    }
    if (req.query.to) {
      args.push(req.query.to);
      conds.push(`cs.scheduled_at < ((($${args.length}::date + INTERVAL '1 day')::timestamp) AT TIME ZONE 'Asia/Taipei')`);
    }
    if (req.query.coachId) {
      args.push(req.query.coachId);
      conds.push(`cp.coach_id = $${args.length}`);
    }
    if (req.query.courseType) {
      args.push(req.query.courseType);
      conds.push(`cp.course_type = $${args.length}`);
    }
    const r = await pool.query(
      `SELECT cs.id AS session_id,
              cs.scheduled_at,
              cs.duration_minutes,
              cs.status AS session_status,
              cp.id AS period_id,
              cp.course_type,
              cp.venue_id,
              COALESCE(cp.is_experience_course, FALSE) AS is_experience_course,
              cp.total_sessions, cp.used_sessions,
              co.id AS coach_id, co.name AS coach_name, co.pricing_multiplier,
              v.name AS venue_name,
              s.id AS student_id, s.name AS student_name,
              cr.id AS checkin_id, cr.checked_in_at,
              cr.checked_in_by_parent_id,
              sr.id AS record_id, sr.status AS record_status,
              pc.partner_parent_id, pc.partner_name, pc.partner_gender
         FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
         JOIN course_periods cp ON cp.id = cpe.course_period_id
         JOIN coaches co ON co.id = cp.coach_id
         JOIN course_sessions cs ON cs.course_period_id = cp.id
         LEFT JOIN venues v ON v.id = cp.venue_id
         LEFT JOIN checkin_records cr ON cr.course_session_id = cs.id AND cr.student_id = s.id
          AND cr.attendance_status = 'ATTENDED'
         LEFT JOIN session_records sr ON sr.course_session_id = cs.id
         -- 團報（跨家庭共班）夥伴代簽：同一堂上「另一位家長」的最早有效簽到。
         -- 僅團報 period（group_order_id 有值）才解析，一般/家庭共班不揭露他人身分。
         LEFT JOIN LATERAL (
           SELECT p2.id AS partner_parent_id, p2.name AS partner_name, p2.gender AS partner_gender
             FROM checkin_records cr2
             JOIN parents p2 ON p2.id = cr2.checked_in_by_parent_id
            WHERE cp.group_order_id IS NOT NULL
              AND cr2.course_session_id = cs.id
              AND cr2.attendance_status = 'ATTENDED'
              AND cr2.checked_in_by_parent_id <> $1
            ORDER BY cr2.checked_in_at
            LIMIT 1
         ) pc ON true
        WHERE ${conds.join(' AND ')}
        ORDER BY cs.scheduled_at DESC
        LIMIT 500`,
      args
    );
    // 夥伴代簽顯示：本家學員尚未簽到、或簽到紀錄由夥伴家長建立時標示；
    // 自己簽的、教練／櫃檯代簽的（checked_in_by_parent_id 為空）不標。
    // 政策變更（2026-07）：團報一方簽到即整組生效，另一方按鈕顯示「已簽＋簽到方
    // 家長姓名」——checked_in_by_name 揭露全名（僅限團報期、僅姓名不含電話）；
    // partner_checkin_label（稱謂版）保留供未更新的舊版前端快取相容。
    const rows = r.rows.map((row) => {
      const {
        partner_parent_id: partnerParentId,
        partner_name: partnerName,
        partner_gender: partnerGender,
        checked_in_by_parent_id: ownAuthor,
        ...rest
      } = row;
      const ownByCoach = !!row.checkin_id && !ownAuthor;
      const showPartner = !!partnerParentId && !ownByCoach
        && (!row.checkin_id || String(ownAuthor) !== String(req.parent.id));
      return {
        ...rest,
        checked_in_by_name: showPartner ? (partnerName || null) : null,
        partner_checkin_label: showPartner ? partnerCheckinLabel(partnerName, partnerGender) : null,
      };
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/courses/mine — 家長查看所有報名（admin_enrollments）
 * 支援主要手機 OR extra_parent_phones（多組家庭同組）
 * requireParent 後 req.parent.phone 由 JWT 帶入
 */
router.get('/mine', requireParent, async (req, res) => {
  try {
    const phone = req.parent.phone;
    const r = await pool.query(
              `SELECT admin_enrollments.id, parent_name, parent_phone, students,
                      coach, coach_id, venue_id, v.name AS venue_name, course_type,
                      original_price, final_price, admin_enrollments.transfer_last_5, status, submitted_at,
                      admin_enrollments.total_sessions, admin_enrollments.used_sessions, admin_enrollments.refund_amount, admin_enrollments.payment_proof_url,
                      admin_enrollments.payment_method, admin_enrollments.order_kind,
                      admin_enrollments.period_count, admin_enrollments.period_number, admin_enrollments.enrollment_batch_id, admin_enrollments.checkout_id,
                      cs.total_amount AS checkout_total_amount,
                      cs.payment_status AS checkout_payment_status,
                      cs.transfer_last_5 AS checkout_transfer_last_5,
                      cs.payment_proof_url AS checkout_payment_proof_url,
                      cs.payment_method AS checkout_payment_method,
                      cs.order_kind AS checkout_order_kind,
                      cs.created_at AS checkout_created_at,
                      invoice_number, invoice_image_url, invoice_url, invoice_issued_at,
                      extra_parent_phones, notes, group_order_id, is_group_shared,
                      -- 已開通正式 course_period（團報走 group_order_id 共用、家庭共班走
                      -- enrollment_batch_id+period_number 共用、其餘走 admin_enrollment_id），
                      -- 以 LATERAL 一次解析，供 期id / 到期 / 總堂數 / 教練修課係數 / 資深旗標 共用。
                      -- 係數/資深取自 course_period 的教練 FK（admin_enrollments.coach_id 多為空，不可靠）。
                      cper.id            AS course_period_id,
                      cper.expires_at,
                      cper.total_sessions AS period_total_sessions,
                      cper.checkin_mode,
                      cper.self_checked_in_today,
                      cper.today_partner_checkin,
                      cper.pricing_multiplier,
                      cper.is_senior,
                      -- 課程轉讓頁(F-S08)用：本家長名下、在該 period active 掛載的學生 {id,name}。
                      (
                        SELECT COALESCE(
                                 jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name),
                                 '[]'::jsonb)
                          FROM course_period_enrollments cpe
                          JOIN students s ON s.id = cpe.student_id
                         WHERE cpe.course_period_id = cper.id
                           AND cpe.status = 'active'
                           AND s.parent_id = $2
                      ) AS students_detail,
                      -- 已用堂數＝該共享 period 下有有效出席的「堂數」（DISTINCT session）。
                      -- 不限本家庭，因家庭共班／團報共用同一堂數池；同堂多位小孩仍只算一堂。
                      (
                        SELECT COUNT(DISTINCT cs2.id)::int
                          FROM course_sessions cs2
                          JOIN checkin_records cr ON cr.course_session_id = cs2.id
                         WHERE cs2.course_period_id = cper.id
                           AND cs2.status::text NOT LIKE 'cancelled%'
                           AND cr.attendance_status = 'ATTENDED'
                      ) AS attended_sessions
                 FROM admin_enrollments
                 LEFT JOIN checkout_sessions cs ON cs.checkout_id = admin_enrollments.checkout_id
                 LEFT JOIN venues v ON v.id = admin_enrollments.venue_id
                 LEFT JOIN LATERAL (
                   SELECT cp.id, cp.total_sessions, cp.expires_at, cp.checkin_mode,
                          co.pricing_multiplier, co.is_senior,
                          EXISTS (SELECT 1 FROM course_sessions cs3
                                   WHERE cs3.course_period_id = cp.id
                                     AND cs3.created_via = 'self_checkin'
                                     AND cs3.self_checkin_date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
                                     AND cs3.status NOT IN ('cancelled_normal','cancelled_penalty')) AS self_checked_in_today,
                          CASE WHEN cp.group_order_id IS NOT NULL THEN (
                            SELECT jsonb_build_object('name', p4.name, 'gender', p4.gender)
                              FROM course_sessions cs4
                              JOIN checkin_records cr4 ON cr4.course_session_id = cs4.id
                              JOIN parents p4 ON p4.id = cr4.checked_in_by_parent_id
                             WHERE cs4.course_period_id = cp.id
                               AND cs4.status::text NOT LIKE 'cancelled%'
                               AND cr4.attendance_status = 'ATTENDED'
                               AND cr4.checked_in_by_parent_id <> $2
                               AND (cr4.checked_in_at AT TIME ZONE 'Asia/Taipei')::date =
                                   (NOW() AT TIME ZONE 'Asia/Taipei')::date
                             ORDER BY cr4.checked_in_at
                             LIMIT 1
                          ) END AS today_partner_checkin
                     FROM course_periods cp
                     LEFT JOIN coaches co ON co.id = cp.coach_id
                    WHERE cp.id = COALESCE(
                            (SELECT cp2.id FROM course_periods cp2
                               WHERE admin_enrollments.group_order_id IS NOT NULL
                                 AND cp2.group_order_id = admin_enrollments.group_order_id
                                 AND cp2.period_number = COALESCE(admin_enrollments.period_number, 1)
                               ORDER BY cp2.created_at LIMIT 1),
                            (SELECT cp2.id FROM course_periods cp2
                               WHERE admin_enrollments.enrollment_batch_id IS NOT NULL
                                 AND cp2.enrollment_batch_id = admin_enrollments.enrollment_batch_id
                                 AND cp2.period_number = COALESCE(admin_enrollments.period_number, 1)
                               LIMIT 1),
                            (SELECT cp2.id FROM course_periods cp2
                               WHERE cp2.admin_enrollment_id = admin_enrollments.id
                               ORDER BY cp2.created_at LIMIT 1))
                 ) cper ON true
                WHERE parent_phone = $1 OR $1 = ANY(extra_parent_phones)
                ORDER BY submitted_at DESC`,
      [phone, req.parent.id]
    );
    // admin_enrollments.status 為 DB 內部狀態（pending_payment/confirmed/cancelled/refunded），
    // 前端課程狀態詞彙為 pending_payment/active/completed/refunded（見 utils/format、mock）。
    // 對帳通過(confirmed)＝課程已開通＝前端「進行中(active)」；未對應到的維持原值。
    // 此正規化同時修好「進行中」分頁與「課程轉讓」頁（兩者都 filter payment_status==='active'）看不到已繳費課程的問題。
    const toPaymentStatus = (s) => (s === 'confirmed' ? 'active' : s);
    // lifecycle：前端 My-Courses 分頁用的課程生命週期狀態（與 payment_status 並存，不取代）。
    //   completed     — 已開通且堂數用畢（total>0 且 used>=total）
    //   active        — 已對帳開通（confirmed/active）但尚未上完
    //   closed        — 已取消/退費（cancelled/refunded）
    //   pending_payment — 其餘（待對帳）原值透傳
    const toLifecycle = (row, total, used) => {
      const s = row.status;
      if (s === 'cancelled' || s === 'refunded') return 'closed';
      if ((s === 'confirmed' || s === 'active') && total > 0 && used >= total) return 'completed';
      if (s === 'confirmed' || s === 'active') return 'active';
      return 'pending_payment';
    };
    const shapedRows = r.rows.map((row) => {
      const ownStudents = Array.isArray(row.students_detail) ? row.students_detail : [];
      const canAccessPeriod = !!row.course_period_id && ownStudents.length > 0;
      // 堂數真相：
      // - 有正式 period 且 period_enrollments 確認掛到本家長學員時，才開放期別操作與使用 period 堂數。
      // - 舊資料可能只有 admin_enrollments.status=active / course_period.admin_enrollment_id，
      //   但缺 course_period_enrollments；若仍回 course_period_id，家長點學習歷程/預約會被
      //   learn/slots 權限守衛 403。這裡收斂成「課程開通處理中」的不可操作狀態。
      const total = canAccessPeriod
        ? (Number(row.period_total_sessions) || Number(row.total_sessions) || 0)
        : (Number(row.total_sessions) || 0);
      const used = canAccessPeriod
        ? (Number(row.attended_sessions) || 0)
        : (Number(row.used_sessions) || 0);
      const remaining = Math.max(0, total - used);
      return {
      id: row.id,
      parent_name: row.parent_name,
      parent_phone: row.parent_phone,
      students: row.students || [],
      students_detail: ownStudents,
              coach: { id: row.coach_id || null, name: row.coach, is_senior: !!row.is_senior },
              coach_name: row.coach,
              venue_id: row.venue_id,
              venue: { id: row.venue_id, name: row.venue_name || row.venue_id },
      course_type: row.course_type,
      original_price: Number(row.original_price),
      final_price: Number(row.final_price),
      transfer_last_5: row.transfer_last_5,
      payment_status: toPaymentStatus(row.status),
      lifecycle: toLifecycle(row, total, used),
      course_period_id: canAccessPeriod ? row.course_period_id : null,
      checkin_mode: canAccessPeriod ? (row.checkin_mode || 'booking') : 'booking',
      self_checked_in_today: canAccessPeriod ? !!row.self_checked_in_today : false,
      partner_checkin_label: canAccessPeriod && row.today_partner_checkin
        ? partnerCheckinLabel(row.today_partner_checkin.name, row.today_partner_checkin.gender)
        : null,
      // 簽到方家長全名（僅團報期；一方簽到後其他成員按鈕顯示「已簽 · 姓名」）
      partner_checkin_name: canAccessPeriod && row.today_partner_checkin
        ? (row.today_partner_checkin.name || null)
        : null,
      expires_at: canAccessPeriod ? row.expires_at : null,
      submitted_at: row.submitted_at,
      total_sessions: total,
      used_sessions: used,
      remaining_sessions: remaining,
      pricing_multiplier: canAccessPeriod ? (Number(row.pricing_multiplier) || 1) : 1,
      refund_amount: row.refund_amount != null ? Number(row.refund_amount) : null,
      invoice_number: row.invoice_number || null,
      invoice_image_url: row.invoice_image_url || null,
      invoice_url: row.invoice_url || null,
      invoice_issued_at: row.invoice_issued_at || null,
      extra_parent_phones: row.extra_parent_phones || [],
      notes: row.notes || null,
      payment_proof_url: row.payment_proof_url || null,
      payment_method: row.payment_method || row.checkout_payment_method || 'bank_transfer',
      order_kind: row.order_kind || row.checkout_order_kind || 'standard',
      period_count: row.period_count || 1,
      period_number: row.period_number || 1,
      enrollment_batch_id: row.enrollment_batch_id || null,
      checkout_id: row.checkout_id || null,
      checkout_total_amount: row.checkout_total_amount != null ? Number(row.checkout_total_amount) : null,
      checkout_payment_status: row.checkout_payment_status || null,
      checkout_transfer_last_5: row.checkout_transfer_last_5 || null,
      checkout_payment_proof_url: row.checkout_payment_proof_url || null,
      checkout_payment_method: row.checkout_payment_method || null,
      checkout_order_kind: row.checkout_order_kind || null,
      checkout_created_at: row.checkout_created_at || null,
      group_order_id: row.group_order_id || null,
      is_group_shared: !!row.is_group_shared,
      };
    });

    // U12 家庭共班顯示合併：同批多學員（一對二以上）開通後共用同一 course_period，
    // 兄弟子訂單合併成「一張」課程卡（學員合併、金額加總；堂數本來就同源自共用 period），
    // 避免 3 位小孩顯示成 3 期 18 堂。合併鍵＝course_period_id（非團報、已開通才會共用）。
    // 一對一多小孩各有獨立 period → 天然不會被合併；取消/退費列維持獨立顯示。
    const periodGroups = new Map();
    const displayRows = [];
    for (const row of shapedRows) {
      const mergeable = !row.group_order_id
        && row.course_period_id
        && (row.lifecycle === 'active' || row.lifecycle === 'completed');
      if (!mergeable) { displayRows.push(row); continue; }
      if (!periodGroups.has(row.course_period_id)) periodGroups.set(row.course_period_id, []);
      periodGroups.get(row.course_period_id).push(row);
    }
    for (const rows of periodGroups.values()) {
      if (rows.length === 1) { displayRows.push(rows[0]); continue; }
      const sorted = rows.slice().sort((a, b) =>
        (new Date(a.submitted_at) - new Date(b.submitted_at)) || String(a.id).localeCompare(String(b.id)));
      const base = sorted[0];
      displayRows.push({
        ...base,
        students: Array.from(new Set(sorted.flatMap((row) => row.students || []).filter(Boolean))),
        original_price: sorted.reduce((sum, row) => sum + (Number(row.original_price) || 0), 0),
        final_price: sorted.reduce((sum, row) => sum + (Number(row.final_price) || 0), 0),
        sub_order_ids: sorted.map((row) => row.id),
        sub_order_count: sorted.length,
      });
    }

    const checkoutGroups = new Map();
    const out = [];
    for (const row of displayRows) {
      const pendingGroupKey = row.lifecycle === 'pending_payment' && !row.group_order_id
        ? (row.checkout_id || (row.enrollment_batch_id ? `batch:${row.enrollment_batch_id}` : null))
        : null;
      if (pendingGroupKey) {
        if (!checkoutGroups.has(pendingGroupKey)) checkoutGroups.set(pendingGroupKey, []);
        checkoutGroups.get(pendingGroupKey).push(row);
      } else {
        out.push(row);
      }
    }

    for (const [groupKey, rows] of checkoutGroups.entries()) {
      const first = rows.slice().sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at))[0];
      const checkoutId = first.checkout_id || null;
      const groupId = checkoutId || first.enrollment_batch_id || groupKey;
      const studentNames = Array.from(new Set(rows.flatMap((row) => row.students || []).filter(Boolean)));
      const periodNumbers = rows.map((row) => Number(row.period_number) || 1);
      const maxPeriodNumber = Math.max(...periodNumbers);
      const periodCount = maxPeriodNumber > 1
        ? maxPeriodNumber
        : Math.max(...rows.map((row) => Number(row.period_count) || 1), rows.length);
      const totalAmount = first.checkout_total_amount != null
        ? first.checkout_total_amount
        : rows.reduce((sum, row) => sum + (Number(row.final_price) || 0), 0);
      const paymentStatus = first.checkout_payment_status || first.payment_status || 'pending_payment';
      out.push({
        ...first,
        id: groupId,
        is_checkout_aggregate: true,
        needs_checkout_route: !checkoutId,
        checkout_id: checkoutId,
        sub_order_ids: rows.map((row) => row.id),
        sub_order_count: rows.length,
        students: studentNames,
        original_price: rows.reduce((sum, row) => sum + (Number(row.original_price) || 0), 0),
        final_price: totalAmount,
        payment_status: paymentStatus,
        lifecycle: 'pending_payment',
        transfer_last_5: first.checkout_transfer_last_5 || first.transfer_last_5 || null,
        payment_proof_url: first.checkout_payment_proof_url || first.payment_proof_url || null,
        period_count: periodCount,
        total_sessions: 0,
        used_sessions: 0,
        remaining_sessions: 0,
        course_period_id: null,
        expires_at: null,
      });
    }

    out.sort((a, b) => new Date(b.submitted_at || b.checkout_created_at || 0) - new Date(a.submitted_at || a.checkout_created_at || 0));
    res.json(out);
  } catch (e) {
    console.error('[courses/mine]', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/courses/types — 公開：LIFF 報名頁的組別卡片只顯示 is_active=true
 * 表 course_type_configs 由後台「課程需求管理」維護（F-A07）。
 */
router.get('/types', async (req, res) => {
  try {
    // 與後台「課程介紹維護」(/admin/course-intros) 同源：JOIN admin_course_intros，
    // 讓家長首頁組別卡片的標題 / 內文 / 封面圖 / 價格完全由後台維護、即時對上。
    const r = await pool.query(
      `SELECT c.course_type, c.label, c.max_students, c.is_active, c.sort_order,
              COALESCE(c.base_price, 0)::float8 AS base_price,
              COALESCE(c.trial_enabled, FALSE)  AS trial_enabled,
              c.trial_price::float8             AS trial_price,
              COALESCE(i.title, c.label)        AS title,
              COALESCE(i.body, '')              AS body,
              COALESCE(i.image_url, '')         AS image_url
         FROM course_type_configs c
         LEFT JOIN admin_course_intros i ON i.course_type = c.course_type
        WHERE c.is_active = TRUE
        ORDER BY c.sort_order, c.course_type`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[courses/types]', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/courses/base-price?courseType=1|2|3
 * LIFF 報名頁取得各組別底價與試上顯示用價格來源。
 * trial_price_course_<N> / trial_price 均為選填覆寫；未設定時前端僅以
 * original_price ÷ sessions_per_period 做同一套保守估算，最終仍由
 * POST /api/enrollments 重新計算。
 */
router.get('/base-price', async (req, res) => {
  const ct = Number(req.query.courseType);
  if (!Number.isInteger(ct) || ct <= 0) {
    return res.status(400).json({ error: 'courseType is required (positive integer)' });
  }
  try {
    const r = await pool.query(
      `SELECT c.course_type,
              c.base_price,
              COALESCE(c.trial_enabled, FALSE) AS trial_enabled,
              COALESCE(c.trial_price,
                       (SELECT value FROM admin_settings WHERE key = ('trial_price_course_' || c.course_type::text)),
                       (SELECT value FROM admin_settings WHERE key = 'trial_price')) AS trial_price,
              COALESCE((SELECT value FROM admin_settings WHERE key = 'sessions_per_period'), 6) AS sessions_per_period
         FROM course_type_configs c
        WHERE c.course_type = $1`,
      [ct]
    );
    if (r.rows.length === 0) {
      return res.status(400).json({ error: `Unknown courseType: ${ct}` });
    }
    res.json({
      course_type: r.rows[0].course_type,
      original_price: Number(r.rows[0].base_price),
      trial_enabled: r.rows[0].trial_enabled === true,
      trial_price: r.rows[0].trial_price == null ? null : Number(r.rows[0].trial_price),
      sessions_per_period: Math.max(1, Number(r.rows[0].sessions_per_period) || 6),
    });
  } catch (e) {
    console.error('[courses/base-price]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id 單筆報名狀態（限本人）— 報名狀態頁用 ──────────────
//    含轉帳帳號（venue）、應繳金額、證明狀態，供「送出後等候畫面」顯示。
router.get('/:id', requireParent, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT e.id, e.parent_phone, e.extra_parent_phones, e.students, e.coach, e.course_type,
              e.original_price, e.final_price, e.transfer_last_5, e.status, e.payment_proof_url,
              e.payment_method, e.order_kind,
              e.period_count, e.enrollment_batch_id, e.checkout_id,
              e.invoice_number, e.invoice_image_url, e.submitted_at, e.group_order_id,
              e.total_sessions, e.used_sessions, e.is_group_shared, e.carrier,
              -- 與 /mine 相同：團報走 group_order_id（共用）、家庭共班走
              -- enrollment_batch_id+period_number（共用）、其餘走 admin_enrollment_id。
              -- 解析收斂在下方 LATERAL cper，一次算好供各欄位共用。
              cper.id AS course_period_id,
              -- 到期日來自正式 course_period（admin_enrollments 無此欄）。
              cper.expires_at,
              cper.checkin_mode,
              cper.self_checked_in_today,
              cper.today_partner_checkin,
              -- 係數/資深取自 course_period 的教練 FK（e.coach_id 多為空，不可靠）。
              cper.pricing_multiplier,
              cper.is_senior,
              -- 已用堂數取共享 period 的有效 DISTINCT session；家庭共班／團報不按學員或家庭倍增。
              (
                SELECT COUNT(DISTINCT cs2.id)::int
                  FROM course_sessions cs2
                  JOIN checkin_records cr ON cr.course_session_id = cs2.id
                 WHERE cs2.course_period_id = cper.id
                   AND cs2.status::text NOT LIKE 'cancelled%'
                   AND cr.attendance_status = 'ATTENDED'
              ) AS attended_sessions,
              cper.total_sessions AS period_total_sessions,
              (
                SELECT COALESCE(
                         jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name),
                         '[]'::jsonb)
                  FROM course_period_enrollments cpe
                  JOIN students s ON s.id = cpe.student_id
                 WHERE cpe.course_period_id = cper.id
                   AND cpe.status = 'active'
                   AND s.parent_id = $2
              ) AS students_detail,
              v.id AS venue_id, v.name AS venue_name,
              -- 匯款帳戶以 admin_venues（F-A03 場館設定，各館各自維護）為準；
              -- 該館尚未設定時才退回 venues 表既有值，避免顯示空白（Task: 匯款帳戶對應館別）。
              COALESCE(NULLIF(av.account_holder, ''), v.account_holder) AS account_holder,
              COALESCE(NULLIF(av.account_number, ''), v.account_number) AS account_number,
              COALESCE(NULLIF(av.bank_institution_name, ''), v.bank_institution_name) AS bank_institution_name,
              COALESCE(NULLIF(av.bank_branch_name, ''), v.bank_branch_name) AS bank_branch_name
         FROM admin_enrollments e
         LEFT JOIN venues v ON v.id = e.venue_id
         LEFT JOIN admin_venues av ON av.id = e.venue_id
         LEFT JOIN LATERAL (
           SELECT cp.id, cp.expires_at, cp.total_sessions, cp.checkin_mode,
                  co.pricing_multiplier, co.is_senior,
                  EXISTS (SELECT 1 FROM course_sessions cs3
                           WHERE cs3.course_period_id = cp.id
                             AND cs3.created_via = 'self_checkin'
                             AND cs3.self_checkin_date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
                             AND cs3.status NOT IN ('cancelled_normal','cancelled_penalty')) AS self_checked_in_today,
                  CASE WHEN cp.group_order_id IS NOT NULL THEN (
                    SELECT jsonb_build_object('name', p4.name, 'gender', p4.gender)
                      FROM course_sessions cs4
                      JOIN checkin_records cr4 ON cr4.course_session_id = cs4.id
                      JOIN parents p4 ON p4.id = cr4.checked_in_by_parent_id
                     WHERE cs4.course_period_id = cp.id
                       AND cs4.status::text NOT LIKE 'cancelled%'
                       AND cr4.attendance_status = 'ATTENDED'
                       AND cr4.checked_in_by_parent_id <> $2
                       AND (cr4.checked_in_at AT TIME ZONE 'Asia/Taipei')::date =
                           (NOW() AT TIME ZONE 'Asia/Taipei')::date
                     ORDER BY cr4.checked_in_at
                     LIMIT 1
                  ) END AS today_partner_checkin
             FROM course_periods cp
             LEFT JOIN coaches co ON co.id = cp.coach_id
            WHERE cp.id = COALESCE(
                    (SELECT cp2.id FROM course_periods cp2
                       WHERE e.group_order_id IS NOT NULL
                         AND cp2.group_order_id = e.group_order_id
                         AND cp2.period_number = COALESCE(e.period_number, 1)
                       ORDER BY cp2.created_at LIMIT 1),
                    (SELECT cp2.id FROM course_periods cp2
                       WHERE e.enrollment_batch_id IS NOT NULL
                         AND cp2.enrollment_batch_id = e.enrollment_batch_id
                         AND cp2.period_number = COALESCE(e.period_number, 1)
                       LIMIT 1),
                    (SELECT cp2.id FROM course_periods cp2
                       WHERE cp2.admin_enrollment_id = e.id
                       ORDER BY cp2.created_at LIMIT 1))
         ) cper ON true
        WHERE e.id = $1`,
      [req.params.id, req.parent.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: '找不到此報名' });
    const row = r.rows[0];
    const phone = req.parent.phone;
    const owns = row.parent_phone === phone || (row.extra_parent_phones || []).includes(phone);
    if (!owns) return res.status(403).json({ error: '無權檢視此報名' });
    const ownStudents = Array.isArray(row.students_detail) ? row.students_detail : [];
    const canAccessPeriod = !!row.course_period_id && ownStudents.length > 0;
    // 舊資料可能有 course_period 但沒有 course_period_enrollments；若把 period id 回給前端，
    // 家長點學習歷程/預約會被 learn/slots 權限守衛 403。沒有本家長 active 學員掛載時，
    // 收斂成「課程開通處理中」不可操作狀態。
    const total = canAccessPeriod
      ? (Number(row.period_total_sessions) || Number(row.total_sessions) || 0)
      : (Number(row.total_sessions) || 0);
    const used = canAccessPeriod
      ? (Number(row.attended_sessions) || 0)
      : (Number(row.used_sessions) || 0);
    const remaining = Math.max(0, total - used);
    // lifecycle：與 /mine 一致的課程生命週期狀態（completed/active/closed/pending_payment）。
    const lifecycle = (() => {
      const s = row.status;
      if (s === 'cancelled' || s === 'refunded') return 'closed';
      if ((s === 'confirmed' || s === 'active') && total > 0 && used >= total) return 'completed';
      if (s === 'confirmed' || s === 'active') return 'active';
      return 'pending_payment';
    })();
    res.json({
      id: row.id,
      students: row.students || [],
      coach: row.coach,
      course_type: row.course_type,
      period_count: row.period_count || 1,
      enrollment_batch_id: row.enrollment_batch_id || null,
      checkout_id: row.checkout_id || null,
      original_price: Number(row.original_price),
      final_price: Number(row.final_price),
      transfer_last_5: row.transfer_last_5 || '',
      carrier: row.carrier || '',
      payment_method: row.payment_method || 'bank_transfer',
      order_kind: row.order_kind || 'standard',
      payment_status: row.status,
      lifecycle,
      course_period_id: canAccessPeriod ? row.course_period_id : null,
      checkin_mode: canAccessPeriod ? (row.checkin_mode || 'booking') : 'booking',
      self_checked_in_today: canAccessPeriod ? !!row.self_checked_in_today : false,
      partner_checkin_label: canAccessPeriod && row.today_partner_checkin
        ? partnerCheckinLabel(row.today_partner_checkin.name, row.today_partner_checkin.gender)
        : null,
      // 簽到方家長全名（僅團報期；SelfCheckinModal 的 blocked 訊息用）
      partner_checkin_name: canAccessPeriod && row.today_partner_checkin
        ? (row.today_partner_checkin.name || null)
        : null,
      total_sessions: total,
      used_sessions: used,
      remaining_sessions: remaining,
      pricing_multiplier: canAccessPeriod ? (Number(row.pricing_multiplier) || 1) : 1,
      is_group_shared: !!row.is_group_shared,
      expires_at: canAccessPeriod ? row.expires_at : null,
      students_detail: ownStudents,
      has_payment_proof: !!row.payment_proof_url,
      submitted_at: row.submitted_at,
      group_order_id: row.group_order_id || null,
      venue: {
        id: row.venue_id, name: row.venue_name,
        account_holder: row.account_holder, account_number: row.account_number,
        bank_institution_name: row.bank_institution_name, bank_branch_name: row.bank_branch_name,
      },
    });
  } catch (e) {
    console.error('[courses/:id]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/payment-proof 事後填寫付款資料（限本人、限待對帳）──
router.post('/:id/payment-proof', requireParent, async (req, res) => {
  const last5 = typeof req.body?.transfer_last_5 === 'string' ? req.body.transfer_last_5.trim() : '';
  // 載具（選填）：電子發票手機條碼載具，trim + 上限長度，空字串視為未填。
  const carrier = typeof req.body?.carrier === 'string' ? req.body.carrier.trim().slice(0, 64) : '';
  if (last5 && !/^\d{5}$/.test(last5)) {
    return res.status(400).json({ error: '轉帳末 5 碼需為 5 位數字', code: 'TRANSFER_LAST5_INVALID' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // checkout payment route 的 lock 順序是 checkout → child enrollment；先讀 soft
    // reference 再鎖 checkout，最後鎖 enrollment，避免與母單更新互相 deadlock。
    const reference = await client.query(
      `SELECT checkout_id FROM admin_enrollments WHERE id = $1`,
      [req.params.id]
    );
    if (!reference.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到此報名' });
    }
    if (reference.rows[0].checkout_id) {
      await client.query(
        `SELECT checkout_id FROM checkout_sessions WHERE checkout_id = $1 FOR UPDATE`,
        [reference.rows[0].checkout_id]
      );
    }
    const r = await client.query(
      `SELECT parent_phone, extra_parent_phones, status, payment_proof_url, transfer_last_5,
              carrier, checkout_id, payment_method
         FROM admin_enrollments WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    const row = r.rows[0];
    if (row.checkout_id !== reference.rows[0].checkout_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: '付款單剛完成建立，請重新送出付款資料',
        code: 'CHECKOUT_CHANGED_RETRY',
      });
    }
    const phone = req.parent.phone;
    if (!(row.parent_phone === phone || (row.extra_parent_phones || []).includes(phone))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '無權操作此報名' });
    }
    if (row.status !== 'pending_payment') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此報名狀態無法再上傳證明', code: 'NOT_PENDING' });
    }
    if (row.payment_method === 'on_site') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此訂單為現場付費，無需上傳轉帳證明', code: 'ON_SITE_PAYMENT_NO_TRANSFER_PROOF' });
    }
    const proofInput = await parseProofInput(req.body, { allowClear: true });
    if (proofInput.error) {
      await client.query('ROLLBACK');
      return res.status(proofInput.status).json({ error: proofInput.error, code: proofInput.code });
    }
    const sameProof = proofInput.supplied && !proofInput.clear
      && proofInput.value === row.payment_proof_url;
    const sameLast5 = !last5 || last5 === row.transfer_last_5;
    // 末碼＋證明皆已送出 → 鎖定唯讀，家長不可自行重編（需聯繫櫃檯）。
    if (row.transfer_last_5 && row.payment_proof_url
        && !proofInput.clear && !(sameProof && sameLast5)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '付款資料已送出，如需更改請聯繫櫃檯', code: 'PAYMENT_LOCKED' });
    }

    const nextProof = proofInput.clear
      ? null
      : proofInput.supplied ? proofInput.value : row.payment_proof_url;
    const nextLast5 = last5 || row.transfer_last_5 || null;
    const nextCarrier = carrier || row.carrier || null;
    if (!proofInput.clear && !nextProof && !nextLast5 && !nextCarrier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '請填寫轉帳末 5 碼或上傳匯款／轉帳證明', code: 'PAYMENT_INFO_REQUIRED' });
    }

    const updateEnrollmentWhere = row.checkout_id
      ? 'checkout_id = $1 AND status = \'pending_payment\''
      : 'id = $1';
    await client.query(
      `UPDATE admin_enrollments
          SET payment_proof_url = $2,
              transfer_last_5 = $3,
              carrier = $4,
              updated_at = NOW()
        WHERE ${updateEnrollmentWhere}`,
      [row.checkout_id || req.params.id, nextProof, nextLast5, nextCarrier]
    );
    if (row.checkout_id) {
      const nextStatus = nextProof || nextLast5 ? 'pending_reconcile' : 'pending_payment';
      await client.query(
        `UPDATE checkout_sessions
            SET payment_proof_url = $2,
                transfer_last_5 = $3,
                carrier = $4,
                payment_status = $5,
                current_route_state = $5,
                updated_at = NOW()
          WHERE checkout_id = $1`,
        [row.checkout_id, nextProof, nextLast5, nextCarrier, nextStatus]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[courses/:id/payment-proof]', { code: e?.code || 'UNEXPECTED' });
    res.status(500).json({ error: '送出付款資料失敗' });
  } finally {
    client.release();
  }
});

// ── POST /:id/cancel 家長取消未完成一般報名（限本人、限待對帳）──
// 團報單需回團購狀態頁由團主取消，避免單一家庭取消破壞已送審名單。
router.post('/:id/cancel', requireParent, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, parent_phone, extra_parent_phones, status, group_order_id, checkout_id
         FROM admin_enrollments
        WHERE id = $1
        FOR UPDATE`,
      [req.params.id]
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到此報名' });
    }
    const row = r.rows[0];
    const owns = row.parent_phone === req.parent.phone || (row.extra_parent_phones || []).includes(req.parent.phone);
    if (!owns) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '無權取消此報名' });
    }
    if (row.group_order_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '團報請至團購狀態頁處理取消', code: 'GROUP_ORDER_CANCEL_REQUIRED' });
    }
    if (row.status !== 'pending_payment') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此報名已進入處理流程，無法由家長取消', code: 'NOT_PENDING' });
    }
    await client.query(
      `UPDATE admin_enrollments
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1`,
      [row.id]
    );
    if (row.checkout_id) {
      await client.query(
        `UPDATE checkout_sessions
            SET payment_status = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM admin_enrollments
                     WHERE checkout_id = $1 AND id <> $2 AND status <> 'cancelled'
                  ) THEN 'cancelled'
                  ELSE payment_status
                END,
                current_route_state = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM admin_enrollments
                     WHERE checkout_id = $1 AND id <> $2 AND status <> 'cancelled'
                  ) THEN 'cancelled'
                  ELSE current_route_state
                END,
                updated_at = NOW()
          WHERE checkout_id = $1`,
        [row.checkout_id, row.id]
      );
    }
    // 取消即釋放此報名占用的優惠用量（同交易內，以 admin_enrollment_id 冪等；無 usage 則 no-op）。
    await promotions.revertUsage({ adminEnrollmentId: row.id }, client);
    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason)
       VALUES ($1, '家長取消未完成報名', 'parent', '家長於 LIFF 取消')`,
      [row.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[courses/:id/cancel]', e);
    res.status(500).json({ error: '取消失敗' });
  } finally {
    client.release();
  }
});

router.all('*', (req, res) => {
  res.status(501).json({ error: 'Not implemented', module: 'courses', path: req.path });
});

module.exports = router;
