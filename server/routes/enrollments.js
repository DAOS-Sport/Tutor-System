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
const { randomUUID } = require('crypto');
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

  // 匯款／轉帳證明在訂單成立後於狀態頁補填；若前端帶值則驗格式後落地。
  const PROOF_URL_RE = /^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{24}\.(jpg|jpeg|png)$/;
  const last5 = String(p.transfer_last_5 || '').trim();
  if (last5 && !/^\d{5}$/.test(last5)) {
    return res.status(400).json({ error: '轉帳末 5 碼格式錯誤', code: 'TRANSFER_LAST5_INVALID' });
  }
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
    // R4 修正：課程組別停用（course_type_configs.is_active=FALSE）時，個人報名路徑須與
    // groupOrders（server/routes/groupOrders.js 讀價處會拒絕停用組別）一致拒絕；先前此處
    // 僅檢查 base_price>0，導致後台停用的組別仍能經個人報名路徑以停用價成立（繞過停用）。
    const courseTypeNum = Number(p.course_type);
    if (!Number.isInteger(courseTypeNum) || courseTypeNum < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid course_type' });
    }
    const cfgRes = await client.query(
      `SELECT base_price, is_active FROM course_type_configs WHERE course_type = $1`,
      [courseTypeNum]
    );
    if (cfgRes.rowCount && cfgRes.rows[0].is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '此課程組別已停用，無法報名', code: 'COURSE_TYPE_INACTIVE' });
    }
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
    const submittedStudentIds = p.students
      .map((s) => String(s?.id || '').trim())
      .filter(Boolean);
    if (submittedStudentIds.length !== studentCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '學員資料不完整' });
    }
    const studentRows = await client.query(
      `SELECT id, name FROM students
        WHERE parent_id = $1 AND id = ANY($2::uuid[]) AND COALESCE(is_active, TRUE) = TRUE`,
      [parentRow.id, submittedStudentIds]
    );
    if (studentRows.rowCount !== studentCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '所選學員不存在、已停用或不屬於您', code: 'STUDENT_NOT_AVAILABLE' });
    }
    const original = unitPrice * studentCount * periodCount;
    const couponCode = p.promotion && p.promotion.coupon_code ? String(p.promotion.coupon_code).trim() : null;

    // ── MGM 體驗課 5 折專用驗證：TRIAL50 僅限有對應 referral 的家長 ──
    if (couponCode && couponCode.toUpperCase() === 'TRIAL50') {
      // R3 修正：加 FOR UPDATE 鎖住這筆 referral row（= markTrialPaid 稍後更新的同一列），
      // 讓同一 (referee, coach) 的並發報名序列化；後到的交易會 block 到前一筆 COMMIT，
      // 於 READ COMMITTED 下重讀時 status 已變 'trial_paid' → 命中 0 列 → 被拒（COUPON_OUT_OF_SCOPE），
      // 消除「一次推薦兌多筆 5 折」的並發雙折。
      const refCheck = await client.query(
        `SELECT id FROM referral_records
          WHERE referee_parent_id = $1 AND coach_id = $2
            AND status IN ('pending','registered')
          FOR UPDATE`,
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
    const studentNames = submittedStudentIds.map((id) => studentRows.rows.find((s) => s.id === id)?.name).filter(Boolean);
    const submittedAt = new Date();

    // 訂單依期數拆分：買 N 期 → 建 N 筆 admin_enrollments，每筆 1 期(6 堂)，各自付款/對帳/鎖定。
    // 折扣門檻仍以整筆購買的 periodCount 計算（見上方 previewBestDiscount，不可改傳 1）。
    const batchId = randomUUID();
    const perPeriodOriginal = unitPrice * studentCount; // 單期原價（含所有學員）
    let totalDiscount = (preview.promotion && preview.discountAmount > 0) ? preview.discountAmount : 0;
    // 先產生各期單號：促銷用量須掛在第一筆，且要「先確認用量」再寫各期價——
    // 自動套用的促銷若在 preview 與 recordUsage（FOR UPDATE 覆核）之間被用盡/停用，
    // 需能改以全額重算各期 final_price，故把用量確認排在各期 INSERT 之前。
    const enrollmentIds = [];
    for (let i = 0; i < periodCount; i += 1) enrollmentIds.push(genEnrollmentId());
    const firstId = enrollmentIds[0];

    // 促銷用量只記一次（掛第一筆 + batch 總額），避免多期被當成多次使用而誤扣 max_uses。
    //  - 家長「明確輸入折價券」（couponCode 有值）失敗 → 整筆退回（COUPON_* 交外層 catch 回 400）。
    //  - 「自動套用」促銷（preview 的 coupon_code 為 NULL）若在此被用盡/失效 → 不中止一筆
    //    全額原本就有效的報名；降級為全額（無折扣、不寫 promotion_usages）並照常成立。
    const explicitCoupon = !!couponCode;
    let usage = null;
    if (totalDiscount > 0) {
      try {
        usage = await promotions.recordUsage({
          promotionId: preview.promotion.id,
          parentId: parentUuid, // 以 phone 解析自 parents 表，無對應則 null
          coursePeriodId: null, // 對帳通過後再產 course_period
          adminEnrollmentId: firstId,
          originalPrice: preview.originalPrice,
          discountAmount: preview.discountAmount,
          finalPrice: preview.finalPrice,
        }, client);
      } catch (err) {
        const softFail = err && err.code
          && ['COUPON_EXHAUSTED', 'COUPON_EXPIRED', 'COUPON_NOT_ACTIVE', 'COUPON_NOT_STARTED'].includes(err.code);
        if (explicitCoupon || !softFail) throw err; // 明確折價券、或非可降級錯誤 → 交外層 catch 整筆退回
        // 自動促銷失效：降級全額，維持報名成立（各期改以全額入庫、回應不帶促銷）。
        totalDiscount = 0;
        usage = null;
        preview.promotion = null;
        preview.discountAmount = 0;
        preview.finalPrice = preview.originalPrice;
      }
    }

    // 折扣按比例分攤到各期、餘數補最後一筆，使 N 筆 final_price 加總 = preview.finalPrice。
    let discountAllocated = 0;
    for (let i = 0; i < periodCount; i += 1) {
      const d = (i < periodCount - 1) ? Math.round(totalDiscount / periodCount) : (totalDiscount - discountAllocated);
      if (i < periodCount - 1) discountAllocated += d;
      const finalThis = Math.max(0, perPeriodOriginal - d);
      const eid = enrollmentIds[i];
      await client.query(
        `INSERT INTO admin_enrollments
           (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
            original_price, final_price, transfer_last_5, payment_proof_url, status, submitted_at,
            period_count, period_number, enrollment_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_payment',$13,1,$14,$15)`,
        [
          eid, parentRow.name, parentRow.phone, studentNames,
          coachName, coachId, venueId, Number(p.course_type),
          perPeriodOriginal, finalThis, last5 || null,
          paymentProofUrl, submittedAt, i + 1, batchId,
        ]
      );
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
         VALUES ($1, $2, $3)`,
        [eid, '家長提交報名', parentRow.phone]
      );
    }

    // MGM：若使用 TRIAL50，更新 referral_records 為 trial_paid（一次推薦＝一次，掛第一筆）。
    // R3 縱深防禦：markTrialPaid 回傳 false 代表這筆推薦已被兌換（並發下另一交易先行）。
    // 上方資格 SELECT 已加 FOR UPDATE 序列化，正常不會走到這裡；但一旦發生即整筆 ROLLBACK，
    // 絕不讓同一推薦兌出第二筆 5 折。
    if (couponCode && couponCode.toUpperCase() === 'TRIAL50') {
      const paid = await referrals.markTrialPaid(
        { refereeParentId: parentRow.id, coachId, enrollmentId: firstId },
        client
      );
      if (!paid) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '此推薦體驗課折扣已被使用，請重新整理後再試',
          code: 'TRIAL50_ALREADY_USED',
        });
      }
    }

    await client.query('COMMIT');

    res.status(201).json({
      id: firstId,        // 相容：維持單一 id（=第一期）供舊呼叫端／單期導頁
      first_id: firstId,
      batch_id: batchId,
      count: periodCount,
      enrollment_ids: enrollmentIds,
      parent_id: parentRow.id,
      coach: p.coach,
      venue: p.venue,
      course_type: Number(p.course_type),
      students: p.students,
      total_sessions: 6,
      used_sessions: 0,
      original_price: preview.originalPrice, // 費用明細顯示整筆（N 期）總額
      final_price: preview.finalPrice,
      payment_status: 'pending_payment',
      transfer_last_5: last5 || null,
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
