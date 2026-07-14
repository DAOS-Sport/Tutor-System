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
const { parseProofInput } = require('../services/paymentProof');
const {
  validateRequestId,
  payloadFingerprint,
  acquireRequestLock,
} = require('../services/idempotency');
const { requireParent } = require('../middlewares/parentAuth');
const {
  createCheckoutSession,
  refreshCheckoutTotal,
  readCheckout,
  routeInstruction,
} = require('../services/checkouts');
const {
  ORDER_KIND,
  PAYMENT_METHOD,
  normalizeOrderKind,
  normalizePaymentMethod,
  calculateTrialPrice,
} = require('../services/trialEnrollment');

const router = express.Router();
const ENROLLMENT_OPERATION = 'create_enrollment_checkout';

function fingerprintEnrollmentPayload(payload) {
  const p = payload || {};
  const orderKind = normalizeOrderKind(p.order_kind);
  const paymentMethod = normalizePaymentMethod(p.payment_method, orderKind);
  const parsedPeriods = parseInt(p.period_count, 10);
  const periodCount = Number.isInteger(parsedPeriods)
    ? Math.min(6, Math.max(1, parsedPeriods))
    : 1;
  const studentIds = Array.isArray(p.students)
    ? p.students.map((student) => String(student?.id || '').trim()).filter(Boolean).sort()
    : [];
  return {
    coach_id: String(p.coach?.id || '').trim(),
    venue_id: String(p.venue?.id || '').trim(),
    course_type: Number(p.course_type),
    student_ids: studentIds,
    period_count: periodCount,
    order_kind: orderKind,
    payment_method: paymentMethod,
    coupon_code: String(p.promotion?.coupon_code || '').trim().toUpperCase() || null,
    transfer_last_5: String(p.transfer_last_5 || '').trim() || null,
    payment_proof_url: String(p.payment_proof_url || '').trim() || null,
    carrier: String(p.carrier || '').trim().slice(0, 64) || null,
  };
}

function idempotentCheckoutResponse(checkout) {
  const instruction = routeInstruction(
    checkout.checkout_id,
    checkout.payment_status,
    checkout.payment_method,
  );
  return {
    status: 'success',
    ok: true,
    checkout_id: checkout.checkout_id,
    batch_id: checkout.enrollment_batch_id || null,
    count: checkout.order_count,
    order_count: checkout.order_count,
    enrollment_ids: (checkout.sub_orders || []).map((order) => order.id),
    payment_method: checkout.payment_method,
    order_kind: checkout.order_kind,
    idempotent: true,
    ...instruction,
    data: { ...instruction, total_amount: checkout.total_amount },
    route_instruction: instruction,
  };
}

router.use(requireParent);

function genEnrollmentId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
  return `E${ts}${rand}`;
}

router.post('/', async (req, res) => {
  const p = req.body || {};
  const requestCheck = validateRequestId(p.request_id || req.get('Idempotency-Key'));
  if (requestCheck.error) {
    return res.status(requestCheck.status).json({ error: requestCheck.error, code: requestCheck.code });
  }
  const idempotencyKey = requestCheck.requestId;
  const fingerprint = payloadFingerprint(fingerprintEnrollmentPayload(p));

  if (!p.coach || !p.venue || !p.course_type
      || !Array.isArray(p.students) || !p.students.length) {
    return res.status(400).json({ error: '報名資料不完整' });
  }

  // 試上是既有一般報名的「明確子類型」，不是另一條未受保護的建單路徑。
  // 除試上外一律維持原本的轉帳流程；不可把任意一般訂單偽裝成現場付費。
  const orderKind = normalizeOrderKind(p.order_kind);
  const paymentMethod = normalizePaymentMethod(p.payment_method, orderKind);
  const isTrial = orderKind === ORDER_KIND.TRIAL;
  if (!isTrial && String(p.payment_method || '').trim().toLowerCase() === PAYMENT_METHOD.ON_SITE) {
    return res.status(400).json({ error: '現場付費僅適用於試上課程', code: 'ON_SITE_TRIAL_ONLY' });
  }

  // 匯款／轉帳證明在訂單成立後於狀態頁補填；若前端帶值，會在取得
  // request advisory lock 與 ledger 後再做真實 storage lookup。
  const last5 = String(p.transfer_last_5 || '').trim();
  if (last5 && !/^\d{5}$/.test(last5)) {
    return res.status(400).json({ error: '轉帳末 5 碼格式錯誤', code: 'TRANSFER_LAST5_INVALID' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // lock 順序固定為 actor/request advisory lock → ledger/existing checkout →
    // parent/business rows。相同 request 的第二個請求會等待第一個 COMMIT/ROLLBACK，
    // 不會在 promotion/referral/order 任一副作用之後才發現重複。
    await acquireRequestLock(client, {
      actorId: req.parent.id,
      operation: ENROLLMENT_OPERATION,
      requestId: idempotencyKey,
    });
    const ledgerResult = await client.query(
      `SELECT id, payload_fingerprint, result_entity_id, status
         FROM request_idempotency_ledger
        WHERE actor_type = 'parent'
          AND actor_id = $1
          AND operation = $2
          AND normalized_request_id = $3
        FOR UPDATE`,
      [req.parent.id, ENROLLMENT_OPERATION, idempotencyKey],
    );
    if (ledgerResult.rowCount) {
      const ledger = ledgerResult.rows[0];
      if (ledger.payload_fingerprint !== fingerprint) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '相同 request ID 已用於不同報名內容',
          code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        });
      }
      if (ledger.status !== 'completed' || !ledger.result_entity_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '此 request ID 正在處理或結果尚未完成，請稍後以相同內容重試',
          code: 'IDEMPOTENCY_IN_PROGRESS',
        });
      }
      const existingCheckout = await readCheckout(client, ledger.result_entity_id);
      if (!existingCheckout) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '此 request ID 的原始付款單不存在，請聯繫櫃檯',
          code: 'IDEMPOTENCY_RESULT_MISSING',
        });
      }
      await client.query('COMMIT');
      return res.status(200).json(idempotentCheckoutResponse(existingCheckout));
    }

    // 向後相容：發布前 checkout_sessions 可能已有 request_id、但尚無新 ledger。
    // 在同一把 advisory lock 下收編成 completed ledger，避免部署後 retry 重建訂單。
    const legacyCheckoutResult = await client.query(
      `SELECT checkout_id, request_payload_fingerprint
         FROM checkout_sessions
        WHERE parent_id = $1 AND request_id = $2
        FOR UPDATE`,
      [req.parent.id, idempotencyKey],
    );
    if (legacyCheckoutResult.rowCount) {
      const checkoutId = legacyCheckoutResult.rows[0].checkout_id;
      const storedFingerprint = legacyCheckoutResult.rows[0].request_payload_fingerprint;
      if (!storedFingerprint || storedFingerprint !== fingerprint) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: storedFingerprint
            ? '相同 request ID 已用於不同報名內容'
            : '此舊付款單缺少 payload fingerprint，無法安全重送，請聯繫櫃檯',
          code: storedFingerprint
            ? 'IDEMPOTENCY_PAYLOAD_MISMATCH'
            : 'IDEMPOTENCY_LEGACY_UNVERIFIABLE',
        });
      }
      const existingCheckout = await readCheckout(client, checkoutId);
      if (!existingCheckout) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '原始付款單資料不完整', code: 'IDEMPOTENCY_RESULT_MISSING' });
      }
      await client.query(
        `INSERT INTO request_idempotency_ledger
           (normalized_request_id, actor_type, actor_id, operation, payload_fingerprint,
            result_entity_id, status, completed_at)
         VALUES ($1,'parent',$2,$3,$4,$5,'completed',NOW())`,
        [idempotencyKey, req.parent.id, ENROLLMENT_OPERATION, fingerprint, checkoutId],
      );
      await client.query('COMMIT');
      return res.status(200).json(idempotentCheckoutResponse(existingCheckout));
    }

    await client.query(
      `INSERT INTO request_idempotency_ledger
         (normalized_request_id, actor_type, actor_id, operation, payload_fingerprint, status)
       VALUES ($1,'parent',$2,$3,$4,'processing')`,
      [idempotencyKey, req.parent.id, ENROLLMENT_OPERATION, fingerprint],
    );

    const proofInput = await parseProofInput(p);
    if (proofInput.error) {
      await client.query('ROLLBACK');
      return res.status(proofInput.status).json({ error: proofInput.error, code: proofInput.code });
    }
    const paymentProofUrl = proofInput.value;
    if (paymentMethod === PAYMENT_METHOD.ON_SITE && (last5 || paymentProofUrl)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: '現場付費訂單不需填寫轉帳資料或上傳轉帳證明',
        code: 'ON_SITE_PAYMENT_FIELDS_NOT_ALLOWED',
      });
    }

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
      `SELECT base_price, is_active, max_students FROM course_type_configs WHERE course_type = $1`,
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
    const suppliedPeriodCount = (() => {
      const n = parseInt(p.period_count, 10);
      return Number.isInteger(n) ? n : 1;
    })();
    const periodCount = (() => {
      const n = parseInt(p.period_count, 10);
      return Number.isInteger(n) ? Math.min(6, Math.max(1, n)) : 1;
    })();
    if (studentCount < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '請選擇至少一位學生' });
    }
    // U12 家庭共班：一對二以上＝同堂共學，單次報名學員數不得超過課型人數上限
    // （超額的班放不下，開通也會壞掉）。一對一不設限——多位小孩＝各自獨立的一對一課。
    const maxStudents = cfgRes.rowCount ? (Number(cfgRes.rows[0].max_students) || 1) : 1;
    if (maxStudents > 1 && studentCount > maxStudents) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `此課程為一對${maxStudents}，單次報名最多 ${maxStudents} 位學員；人數更多請分次報名或使用團體報名`,
        code: 'STUDENT_COUNT_EXCEEDS_COURSE_TYPE',
      });
    }
    if (isTrial && (studentCount !== 1 || suppliedPeriodCount !== 1)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: '試上課程限單一學員、單次下單',
        code: 'TRIAL_SINGLE_ORDER_REQUIRED',
      });
    }
    const submittedStudentIds = p.students
      .map((s) => String(s?.id || '').trim())
      .filter(Boolean);
    if (submittedStudentIds.length !== studentCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '學員資料不完整' });
    }
    if (new Set(submittedStudentIds).size !== submittedStudentIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '學員資料重複，請重新選擇', code: 'DUPLICATE_STUDENT' });
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
    const settingsRows = await client.query(
      `SELECT key, value FROM admin_settings
        WHERE key IN ('sessions_per_period', 'trial_price', $1)`,
      [`trial_price_course_${courseTypeNum}`]
    );
    const settings = Object.fromEntries(settingsRows.rows.map((row) => [row.key, row.value]));
    const trialPrice = isTrial
      ? calculateTrialPrice({ basePrice: unitPrice, courseType: courseTypeNum, settings })
      : null;
    if (isTrial && trialPrice <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '試上課程價格尚未設定，請洽櫃檯', code: 'TRIAL_PRICE_NOT_CONFIGURED' });
    }
    const original = isTrial ? trialPrice : (unitPrice * studentCount * periodCount);
    const couponCode = p.promotion && p.promotion.coupon_code ? String(p.promotion.coupon_code).trim() : null;

    if (isTrial && couponCode) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '試上課程不支援折價券，請先移除折價券後再送出', code: 'TRIAL_COUPON_NOT_SUPPORTED' });
    }

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

    let preview = {
      originalPrice: original,
      discountAmount: 0,
      finalPrice: original,
      promotion: null,
    };
    if (!isTrial) {
      try {
        preview = await promotions.previewBestDiscount({
          originalPrice: original,
          courseType: Number(p.course_type),
          venueId: p.venue.id || null,
          periodCount,
          couponCode,
          parentId: parentRow.id,
          coachMultiplier: multiplier, // 權威值：來自 DB coaches.pricing_multiplier（第 155 行），不信前端
        });
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code && err.code.startsWith('COUPON_')) {
          return res.status(400).json({
            error: err.publicMessage ? err.message : '折價券無法使用，請確認代碼或重新試算',
            code: err.publicMessage ? err.code : 'COUPON_INVALID',
          });
        }
        throw err;
      }
    }

    const parentUuid = parentRow.id;
    const studentById = new Map(studentRows.rows.map((s) => [String(s.id), s]));
    const selectedStudents = submittedStudentIds
      .map((id) => studentById.get(id))
      .filter(Boolean);
    const studentNames = selectedStudents.map((s) => s.name);
    const submittedAt = new Date();

    // 訂單依「學員 × 期數」拆分：
    // 2 位學員買 4 期 → 建 8 筆 admin_enrollments，每筆只代表 1 位學員的 1 期。
    // 這讓 checkout 母單仍聚合總額，但後續對帳、開通與發票品項都能精準到單生單期。
    // 折扣門檻仍以整筆購買的 periodCount 計算（見上方 previewBestDiscount，不可改傳 1）。
    const batchId = randomUUID();
    const childOrderCount = isTrial ? 1 : (studentCount * periodCount);
    const perChildOriginal = isTrial ? original : unitPrice; // 單一學員、單一期的原價
    let totalDiscount = (preview.promotion && preview.discountAmount > 0) ? preview.discountAmount : 0;
    // 先產生各子訂單單號：促銷用量須掛在第一筆，且要「先確認用量」再寫各期價——
    // 自動套用的促銷若在 preview 與 recordUsage（FOR UPDATE 覆核）之間被用盡/停用，
    // 需能改以全額重算各期 final_price，故把用量確認排在各期 INSERT 之前。
    const enrollmentIds = [];
    for (let i = 0; i < childOrderCount; i += 1) enrollmentIds.push(genEnrollmentId());
    const firstId = enrollmentIds[0];

    const checkout = await createCheckoutSession(client, {
      parentId: parentUuid,
      enrollmentBatchId: batchId,
      totalAmount: preview.finalPrice,
      transferLast5: last5 || null,
      paymentProofUrl,
      carrier: p.carrier ? String(p.carrier).trim().slice(0, 64) : null,
      requestId: idempotencyKey,
      by: parentRow.phone,
      paymentMethod,
      orderKind,
      requestFingerprint: fingerprint,
    });
    if (!checkout.created && checkout.enrollmentBatchId !== batchId) {
      await client.query(
        `UPDATE request_idempotency_ledger
            SET result_entity_id = $4, status = 'completed', completed_at = NOW()
          WHERE actor_type = 'parent' AND actor_id = $1
            AND operation = $2 AND normalized_request_id = $3`,
        [req.parent.id, ENROLLMENT_OPERATION, idempotencyKey, checkout.checkoutId],
      );
      const existingCheckout = await readCheckout(client, checkout.checkoutId);
      if (!existingCheckout) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '原始付款單資料不完整', code: 'IDEMPOTENCY_RESULT_MISSING' });
      }
      await client.query('COMMIT');
      return res.status(200).json(idempotentCheckoutResponse(existingCheckout));
    }

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
          requestPeriods: periodCount,
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

    // 折扣按比例分攤到每一筆「單生單期」子訂單，餘數補最後一筆，
    // 使所有子訂單 final_price 加總嚴格等於 preview.finalPrice / checkout total_amount。
    let discountAllocated = 0;
    let orderIndex = 0;
    for (const student of selectedStudents) {
      for (let period = 1; period <= (isTrial ? 1 : periodCount); period += 1) {
        const d = (orderIndex < childOrderCount - 1)
          ? Math.round(totalDiscount / childOrderCount)
          : (totalDiscount - discountAllocated);
        if (orderIndex < childOrderCount - 1) discountAllocated += d;
        const finalThis = Math.max(0, perChildOriginal - d);
        const eid = enrollmentIds[orderIndex];
        await client.query(
          `INSERT INTO admin_enrollments
             (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
              original_price, final_price, transfer_last_5, payment_proof_url, status, submitted_at,
              period_count, period_number, enrollment_batch_id, checkout_id, carrier, payment_method,
              order_kind, total_sessions, used_sessions)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_payment',$13,1,$14,$15,$16,$17,$18,$19,$20,0)`,
          [
            eid, parentRow.name, parentRow.phone, [student.name],
            coachName, coachId, venueId, Number(p.course_type),
            perChildOriginal, finalThis, last5 || null,
            paymentProofUrl, submittedAt, period, batchId, checkout.checkoutId,
            p.carrier ? String(p.carrier).trim().slice(0, 64) : null,
            paymentMethod, orderKind, isTrial ? 1 : 6,
          ]
        );
        await client.query(
          `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
           VALUES ($1, $2, $3)`,
          [eid, isTrial
            ? `家長提交試上課程（${paymentMethod === PAYMENT_METHOD.ON_SITE ? '現場付費' : '轉帳'}）`
            : '家長提交報名', parentRow.phone]
        );
        orderIndex += 1;
      }
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

    await refreshCheckoutTotal(client, checkout.checkoutId);
    await client.query(
      `UPDATE request_idempotency_ledger
          SET result_entity_id = $4, status = 'completed', completed_at = NOW()
        WHERE actor_type = 'parent' AND actor_id = $1
          AND operation = $2 AND normalized_request_id = $3`,
      [req.parent.id, ENROLLMENT_OPERATION, idempotencyKey, checkout.checkoutId],
    );
    const totalCheck = await client.query(
      `SELECT total_amount FROM checkout_sessions WHERE checkout_id = $1`,
      [checkout.checkoutId]
    );
    const checkoutTotalAmount = Number(totalCheck.rows[0]?.total_amount ?? preview.finalPrice) || 0;
    await client.query('COMMIT');
    const instruction = routeInstruction(checkout.checkoutId, checkout.paymentStatus, checkout.paymentMethod);

    res.status(201).json({
      status: 'success',
      id: firstId,        // 相容：維持單一 id（=第一期）供舊呼叫端／單期導頁
      first_id: firstId,
      batch_id: batchId,
      checkout_id: checkout.checkoutId,
      count: enrollmentIds.length,
      period_count: periodCount,
      student_count: studentCount,
      order_count: enrollmentIds.length,
      enrollment_ids: enrollmentIds,
      parent_id: parentRow.id,
      coach: p.coach,
      venue: p.venue,
      course_type: Number(p.course_type),
      students: p.students,
      total_sessions: isTrial ? 1 : 6,
      used_sessions: 0,
      original_price: preview.originalPrice, // 費用明細顯示整筆（N 期）總額
      final_price: checkoutTotalAmount,
      payment_status: 'pending_payment',
      transfer_last_5: last5 || null,
      payment_proof_url: paymentProofUrl,
      payment_method: paymentMethod,
      order_kind: orderKind,
      ...instruction,
      data: { ...instruction, total_amount: checkoutTotalAmount },
      route_instruction: instruction,
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
    console.error('[enrollments create]', { code: err?.code || 'UNEXPECTED' });
    if (err && err.code && String(err.code).startsWith('COUPON_')) {
      return res.status(400).json({
        error: err.publicMessage ? err.message : '折價券無法使用，請確認代碼或重新試算',
        code: err.publicMessage ? err.code : 'COUPON_INVALID',
      });
    }
    res.status(500).json({ error: 'enrollment create failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
