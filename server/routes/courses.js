/**
 * 家長端課程查詢 (F-S07 上課記錄)
 *   GET /api/courses/lessons   登入家長的所有上課記錄（含已簽到）
 */
const express = require('express');
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const { objectExists } = require('../services/objectStorage');

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
      conds.push(`cs.scheduled_at >= $${args.length}::date`);
    }
    if (req.query.to) {
      args.push(req.query.to);
      conds.push(`cs.scheduled_at < ($${args.length}::date + INTERVAL '1 day')`);
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
              cs.status AS session_status,
              cp.id AS period_id,
              cp.course_type,
              cp.venue_id,
              co.id AS coach_id, co.name AS coach_name,
              s.id AS student_id, s.name AS student_name,
              cr.id AS checkin_id, cr.checked_in_at,
              sr.id AS record_id, sr.status AS record_status
         FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
         JOIN course_periods cp ON cp.id = cpe.course_period_id
         JOIN coaches co ON co.id = cp.coach_id
         JOIN course_sessions cs ON cs.course_period_id = cp.id
         LEFT JOIN checkin_records cr ON cr.course_session_id = cs.id AND cr.student_id = s.id
         LEFT JOIN session_records sr ON sr.course_session_id = cs.id
        WHERE ${conds.join(' AND ')}
        ORDER BY cs.scheduled_at DESC
        LIMIT 500`,
      args
    );
    res.json(r.rows);
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
	              original_price, final_price, transfer_last_5, status, submitted_at,
	              total_sessions, used_sessions, refund_amount, payment_proof_url, period_count,
	              invoice_number, invoice_image_url, invoice_url, invoice_issued_at,
              extra_parent_phones, notes, group_order_id, is_group_shared,
              -- 對帳通過後自動開通的正式 course_period：團報走 group_order_id（共用），
              -- 一般報名走 admin_enrollment_id。供前端導去學習歷程/詳細頁（該頁以 period id 查歸屬）。
              COALESCE(
                (SELECT cp.id FROM course_periods cp
                   WHERE admin_enrollments.group_order_id IS NOT NULL
                     AND cp.group_order_id = admin_enrollments.group_order_id
                   ORDER BY cp.created_at LIMIT 1),
                (SELECT cp.id FROM course_periods cp
                   WHERE cp.admin_enrollment_id = admin_enrollments.id
                   ORDER BY cp.created_at LIMIT 1)
	              ) AS course_period_id
	         FROM admin_enrollments
	         LEFT JOIN venues v ON v.id = admin_enrollments.venue_id
	        WHERE parent_phone = $1 OR $1 = ANY(extra_parent_phones)
	        ORDER BY submitted_at DESC`,
      [phone]
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
    const toLifecycle = (row) => {
      const total = Number(row.total_sessions) || 0;
      const used = Number(row.used_sessions) || 0;
      const s = row.status;
      if (s === 'cancelled' || s === 'refunded') return 'closed';
      if ((s === 'confirmed' || s === 'active') && total > 0 && used >= total) return 'completed';
      if (s === 'confirmed' || s === 'active') return 'active';
      return 'pending_payment';
    };
    res.json(r.rows.map((row) => ({
      id: row.id,
      parent_name: row.parent_name,
      parent_phone: row.parent_phone,
      students: row.students || [],
	      coach: { id: row.coach_id || null, name: row.coach },
	      coach_name: row.coach,
	      venue_id: row.venue_id,
	      venue: { id: row.venue_id, name: row.venue_name || row.venue_id },
      course_type: row.course_type,
      original_price: Number(row.original_price),
      final_price: Number(row.final_price),
      transfer_last_5: row.transfer_last_5,
      payment_status: toPaymentStatus(row.status),
      lifecycle: toLifecycle(row),
      course_period_id: row.course_period_id || null,
      submitted_at: row.submitted_at,
      total_sessions: row.total_sessions,
      used_sessions: row.used_sessions,
      refund_amount: row.refund_amount != null ? Number(row.refund_amount) : null,
      invoice_number: row.invoice_number || null,
      invoice_image_url: row.invoice_image_url || null,
      invoice_url: row.invoice_url || null,
      invoice_issued_at: row.invoice_issued_at || null,
      extra_parent_phones: row.extra_parent_phones || [],
      notes: row.notes || null,
      payment_proof_url: row.payment_proof_url || null,
      period_count: row.period_count || 1,
      group_order_id: row.group_order_id || null,
      is_group_shared: !!row.is_group_shared,
    })));
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
    const r = await pool.query(
      `SELECT course_type, label, max_students, is_active, sort_order
         FROM course_type_configs
        WHERE is_active = TRUE
        ORDER BY sort_order, course_type`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[courses/types]', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/courses/base-price?courseType=1|2|3
 * LIFF 報名頁取得各組別底價，回傳 { course_type, original_price }。
 */
router.get('/base-price', async (req, res) => {
  const ct = Number(req.query.courseType);
  if (!Number.isInteger(ct) || ct <= 0) {
    return res.status(400).json({ error: 'courseType is required (positive integer)' });
  }
  try {
    const r = await pool.query(
      `SELECT course_type, base_price FROM course_type_configs WHERE course_type = $1`,
      [ct]
    );
    if (r.rows.length === 0) {
      return res.status(400).json({ error: `Unknown courseType: ${ct}` });
    }
    res.json({ course_type: r.rows[0].course_type, original_price: Number(r.rows[0].base_price) });
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
              e.original_price, e.final_price, e.transfer_last_5, e.status, e.payment_proof_url, e.period_count,
              e.invoice_number, e.invoice_image_url, e.submitted_at, e.group_order_id,
              e.total_sessions, e.used_sessions, e.is_group_shared,
              -- 與 /mine 相同：團報走 group_order_id（共用）、一般報名走 admin_enrollment_id。
              COALESCE(
                (SELECT cp.id FROM course_periods cp
                   WHERE e.group_order_id IS NOT NULL
                     AND cp.group_order_id = e.group_order_id
                   ORDER BY cp.created_at LIMIT 1),
                (SELECT cp.id FROM course_periods cp
                   WHERE cp.admin_enrollment_id = e.id
                   ORDER BY cp.created_at LIMIT 1)
              ) AS course_period_id,
              -- 到期日來自正式 course_period（admin_enrollments 無此欄）。
              COALESCE(
                (SELECT cp.expires_at FROM course_periods cp
                   WHERE e.group_order_id IS NOT NULL
                     AND cp.group_order_id = e.group_order_id
                   ORDER BY cp.created_at LIMIT 1),
                (SELECT cp.expires_at FROM course_periods cp
                   WHERE cp.admin_enrollment_id = e.id
                   ORDER BY cp.created_at LIMIT 1)
              ) AS expires_at,
              v.id AS venue_id, v.name AS venue_name, v.account_holder, v.account_number,
              v.bank_institution_name, v.bank_branch_name
         FROM admin_enrollments e
         LEFT JOIN venues v ON v.id = e.venue_id
        WHERE e.id = $1`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: '找不到此報名' });
    const row = r.rows[0];
    const phone = req.parent.phone;
    const owns = row.parent_phone === phone || (row.extra_parent_phones || []).includes(phone);
    if (!owns) return res.status(403).json({ error: '無權檢視此報名' });
    // lifecycle：與 /mine 一致的課程生命週期狀態（completed/active/closed/pending_payment）。
    const lifecycle = (() => {
      const total = Number(row.total_sessions) || 0;
      const used = Number(row.used_sessions) || 0;
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
      original_price: Number(row.original_price),
      final_price: Number(row.final_price),
      transfer_last_5: row.transfer_last_5 || '',
      payment_status: row.status,
      lifecycle,
      course_period_id: row.course_period_id || null,
      total_sessions: row.total_sessions,
      used_sessions: row.used_sessions,
      is_group_shared: !!row.is_group_shared,
      expires_at: row.expires_at || null,
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
  const PROOF_URL_RE = /^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{24}\.(jpg|jpeg|png)$/;
  const url = typeof req.body?.payment_proof_url === 'string' ? req.body.payment_proof_url.trim() : '';
  const last5 = typeof req.body?.transfer_last_5 === 'string' ? req.body.transfer_last_5.trim() : '';
  if (last5 && !/^\d{5}$/.test(last5)) {
    return res.status(400).json({ error: '轉帳末 5 碼需為 5 位數字', code: 'TRANSFER_LAST5_INVALID' });
  }
  if (url && (!PROOF_URL_RE.test(url) || !objectExists(url))) {
    return res.status(400).json({ error: '請上傳有效的匯款／轉帳證明', code: 'PAYMENT_PROOF_INVALID' });
  }
  try {
    const r = await pool.query(
      `SELECT parent_phone, extra_parent_phones, status, payment_proof_url, transfer_last_5
         FROM admin_enrollments WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: '找不到此報名' });
    const row = r.rows[0];
    const phone = req.parent.phone;
    if (!(row.parent_phone === phone || (row.extra_parent_phones || []).includes(phone))) {
      return res.status(403).json({ error: '無權操作此報名' });
    }
    if (row.status !== 'pending_payment') {
      return res.status(409).json({ error: '此報名狀態無法再上傳證明', code: 'NOT_PENDING' });
    }
    if (!url && !row.payment_proof_url && !last5) {
      return res.status(400).json({ error: '請填寫轉帳末 5 碼或上傳匯款／轉帳證明', code: 'PAYMENT_INFO_REQUIRED' });
    }
    await pool.query(
      `UPDATE admin_enrollments
          SET payment_proof_url = COALESCE($2, payment_proof_url),
              transfer_last_5 = COALESCE($3, transfer_last_5),
              updated_at = NOW()
        WHERE id = $1`,
      [req.params.id, url || null, last5 || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[courses/:id/payment-proof]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/cancel 家長取消未完成一般報名（限本人、限待對帳）──
// 團報單需回團購狀態頁由團主取消，避免單一家庭取消破壞已送審名單。
router.post('/:id/cancel', requireParent, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, parent_phone, extra_parent_phones, status, group_order_id
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
