/**
 * LIFF 報名建立 (POST /api/enrollments)
 *
 * 為 Phase 6（上）F-S02「補充購課套用」串接後端寫入路徑：
 *   1. 接收 LIFF EnrollmentPage 送出的 payload
 *   2. 後端「重新計算」優惠折抵（不信任 client 傳來的 final_price），
 *      避免被竄改；不一致時直接以伺服器計算結果為準。
 *   3. 同一交易內：INSERT admin_enrollments + (有優惠則) services.recordUsage
 *      → 確保 promotion_usages 與 promotions.current_uses 同步、原子。
 *
 * 不在本任務範圍：core course_periods 真實寫入；本路由只建立 admin_enrollments
 * (pending_payment) 等管理後台對帳通過後再 promote 為正式 course_period。
 */
const express = require('express');
const { pool } = require('../models/db');
const promotions = require('../services/promotions');
const referrals = require('../services/referrals');
const { objectExists } = require('../services/objectStorage');
const { requireParent } = require('../middlewares/parentAuth');

const router = express.Router();
router.use(requireParent);

function genEnrollmentId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `E${ts}${rand}`;
}

router.post('/', async (req, res) => {
  const p = req.body || {};
  if (!p.coach || !p.venue || !p.course_type
      || !Array.isArray(p.students) || !p.students.length) {
    return res.status(400).json({ error: '報名資料不完整' });
  }

  // U10：匯款／轉帳證明改為「送出後在報名狀態頁再上傳」，這裡不再必填。
  //   若前端仍帶（向後相容）才驗格式 + 落地存在；格式與 LocalDiskDriver 綁定。
  const PROOF_URL_RE = /^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{24}\.(jpg|jpeg|png)$/;
  const rawProof = typeof p.payment_proof_url === 'string' ? p.payment_proof_url.trim() : '';
  let paymentProofUrl = null;
  if (rawProof) {
    if (!PROOF_URL_RE.test(rawProof) || !objectExists(rawProof)) {
      return res.status(400).json({ error: '匯款／轉帳證明格式不正確', code: 'PAYMENT_PROOF_INVALID' });
    }
    paymentProofUrl = rawProof;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── server-authoritative 身份綁定：忽略 client 傳來的 parent_name/phone/id
    //    一律以 JWT 解出的 req.parent.id 為準，從 parents 表讀真實資料 ──
    const pr = await client.query(
      `SELECT id, name, phone FROM parents WHERE id = $1`,
      [req.parent.id]
    );
    if (!pr.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'parent identity not found' });
    }
    const parentRow = pr.rows[0];

    // ── 後端重算 (server-authoritative)：完全忽略 client 的 original_price ──
    // 單期基準價一律讀 course_type_configs（後台可改），與報名頁試算 /api/courses/base-price
    // 及團報計價同源，避免後台改價後「顯示價 ≠ 入庫價」。DECIMAL 經 pg 回字串，需 Number() 轉型。
    // 不加 is_active 過濾——與 courses.js / groupOrders.js 讀價路徑一致，不在此單元改變停用語意。
    const courseTypeNum = Number(p.course_type);
    if (!Number.isInteger(courseTypeNum) || courseTypeNum < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid course_type' });
    }
    const cfgRes = await client.query(
      `SELECT base_price FROM course_type_configs WHERE course_type = $1`,
      [courseTypeNum]
    );
    const basePrice = cfgRes.rowCount ? Number(cfgRes.rows[0].base_price) || 0 : 0;
    if (basePrice <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '此課程組別尚未設定價格，請洽櫃檯', code: 'PRICE_NOT_CONFIGURED' });
    }
    // 教練必須為合法 UUID 並存在於 active coaches；倍率只能來自 DB（fail-closed，無 fallback）。
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const coachId = p.coach && p.coach.id ? String(p.coach.id) : '';
    if (!UUID_RE.test(coachId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid coach id' });
    }
    const cr = await client.query(
      `SELECT name, pricing_multiplier FROM coaches WHERE id = $1 AND is_active = TRUE`,
      [coachId]
    );
    if (!cr.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'coach not found or inactive' });
    }
    const multiplier = Number(cr.rows[0].pricing_multiplier) || 1;
    const coachName = cr.rows[0].name;
    // 場館必須存在
    const venueId = p.venue && p.venue.id ? String(p.venue.id) : '';
    // Task #84：FOR SHARE 鎖此 venue row，避免「停用 commit 與 enrollment INSERT」
    // 並發時讓一筆新報名漏進來。
    const vr = await client.query(
      `SELECT id, is_active FROM venues WHERE id = $1 FOR SHARE`,
      [venueId]
    );
    if (!vr.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'venue not found' });
    }
    // Task #84：場館停用後拒絕新報名（已售出課程不受影響）
    if (vr.rows[0].is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: '該場館已停用，目前無法接受新報名，請選擇其他場館',
        code: 'VENUE_INACTIVE',
      });
    }
    // U10：費用 = 單期單生價(base×倍率) × 學生數 × 期數（server-authoritative，忽略 client 金額）。
    const unitPrice = Math.round(basePrice * multiplier);
    const studentCount = Array.isArray(p.students) ? p.students.length : 0;
    const periodCount = (() => {
      const n = parseInt(p.period_count, 10);
      return Number.isInteger(n) ? Math.min(6, Math.max(1, n)) : 1;
    })();
    if (studentCount < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '請選擇至少一位學生' });
    }
    const original = unitPrice * studentCount * periodCount;
    const couponCode = p.promotion && p.promotion.coupon_code ? String(p.promotion.coupon_code).trim() : null;

    // ── MGM 體驗課 5 折專用驗證：TRIAL50 僅限有對應 referral 的家長 ──
    if (couponCode && couponCode.toUpperCase() === 'TRIAL50') {
      const refCheck = await client.query(
        `SELECT id FROM referral_records
          WHERE referee_parent_id = $1 AND coach_id = $2
            AND status IN ('pending','registered')`,
        [parentRow.id, coachId]
      );
      if (!refCheck.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'TRIAL50 僅限受推薦的新學員於對應教練使用',
          code: 'COUPON_OUT_OF_SCOPE',
        });
      }
    }

    let preview;
    try {
      preview = await promotions.previewBestDiscount({
        originalPrice: original,
        courseType: Number(p.course_type),
        venueId: p.venue.id || null,
        periodCount,
        couponCode,
        parentId: parentRow.id,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code && err.code.startsWith('COUPON_')) {
        return res.status(400).json({ error: '折價券無法使用，請確認代碼或重新試算', code: 'COUPON_INVALID' });
      }
      throw err;
    }

    const parentUuid = parentRow.id;
    const enrollmentId = genEnrollmentId();
    const studentNames = p.students.map((s) => s.name);
    const submittedAt = new Date();

    await client.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
          original_price, final_price, transfer_last_5, payment_proof_url, status, submitted_at, period_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_payment',$13,$14)`,
      [
        enrollmentId, parentRow.name, parentRow.phone, studentNames,
        coachName, coachId, venueId, Number(p.course_type),
        preview.originalPrice, preview.finalPrice, p.transfer_last_5 || null,
        paymentProofUrl,
        submittedAt, periodCount,
      ]
    );

    let usage = null;
    if (preview.promotion && preview.discountAmount > 0) {
      usage = await promotions.recordUsage({
        promotionId: preview.promotion.id,
        parentId: parentUuid, // 以 phone 解析自 parents 表，無對應則 null
        coursePeriodId: null, // 對帳通過後再產 course_period
        adminEnrollmentId: enrollmentId,
        originalPrice: preview.originalPrice,
        discountAmount: preview.discountAmount,
        finalPrice: preview.finalPrice,
      }, client);
    }

    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
       VALUES ($1, $2, $3)`,
      [enrollmentId, '家長提交報名', parentRow.phone]
    );

    // MGM：若使用 TRIAL50，更新 referral_records 為 trial_paid
    if (couponCode && couponCode.toUpperCase() === 'TRIAL50') {
      await referrals.markTrialPaid(
        { refereeParentId: parentRow.id, coachId, enrollmentId },
        client
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      id: enrollmentId,
      parent_id: parentRow.id,
      coach: p.coach,
      venue: p.venue,
      course_type: Number(p.course_type),
      students: p.students,
      total_sessions: 6,
      used_sessions: 0,
      original_price: preview.originalPrice,
      final_price: preview.finalPrice,
      payment_status: 'pending_payment',
      transfer_last_5: p.transfer_last_5 || null,
      payment_proof_url: paymentProofUrl,
      promotion: preview.promotion ? {
        id: preview.promotion.id,
        name: preview.promotion.name,
        coupon_code: preview.promotion.coupon_code,
        discount: preview.discountAmount,
      } : null,
      promotion_usage_id: usage ? usage.id : null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[enrollments create]', err);
    if (err && err.code && String(err.code).startsWith('COUPON_')) {
      return res.status(400).json({ error: '折價券無法使用，請確認代碼或重新試算', code: 'COUPON_INVALID' });
    }
    res.status(500).json({ error: 'enrollment create failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
