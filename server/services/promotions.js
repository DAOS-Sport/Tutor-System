/**
 * 優惠活動計算服務（資料隔離核心）
 * - 課程期只記錄 original_price / final_price
 * - 所有優惠計算在此服務完成，結果寫入 promotion_usages
 *
 * Phase 6（上）schema：
 *   promotions: type ('PERCENTAGE'|'FIXED_AMOUNT'), discount_value (NUMERIC),
 *               min_threshold_type ('PERIOD_COUNT'), min_threshold_value,
 *               applicable_course_types INTEGER[], applicable_venue_ids VARCHAR[],
 *               coupon_code (NULL = 自動套用), status, start/end date, max_uses
 */
const { pool } = require('../models/db');

function toISODate(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function isWithinWindow(p, today) {
  return toISODate(p.start_date) <= today && toISODate(p.end_date) >= today;
}

function matchScope(p, { courseType, venueId, periodCount }) {
  const typeOk =
    !p.applicable_course_types ||
    p.applicable_course_types.length === 0 ||
    p.applicable_course_types.includes(courseType);
  const venueOk =
    !p.applicable_venue_ids ||
    p.applicable_venue_ids.length === 0 ||
    (venueId && p.applicable_venue_ids.includes(venueId));
  const threshOk =
    !p.min_threshold_type ||
    !p.min_threshold_value ||
    (p.min_threshold_type === 'PERIOD_COUNT' && (periodCount || 1) >= p.min_threshold_value);
  return typeOk && venueOk && threshOk;
}

function computeDiscount(p, originalPrice) {
  const v = parseFloat(p.discount_value);
  if (p.type === 'PERCENTAGE') {
    // discount_value 為「保留比例」（0.9 = 9折）→ 折抵 = price * (1-v)
    return Math.max(0, Math.round(originalPrice * (1 - v)));
  }
  if (p.type === 'FIXED_AMOUNT') {
    return Math.min(originalPrice, Math.max(0, Math.round(v)));
  }
  return 0;
}

/**
 * 列出 LIFF / R05 可見的「目前進行中」自動套用優惠（不含折價券需代碼者）。
 */
async function listActivePromotions({ today } = {}) {
  const t = today || new Date().toISOString().slice(0, 10);
  const r = await pool.query(
    `SELECT id, name, description, type, discount_value, min_threshold_type, min_threshold_value,
            applicable_course_types, applicable_venue_ids, coupon_code,
            start_date, end_date, max_uses, current_uses
       FROM promotions
      WHERE status = 'active'
        AND start_date <= $1 AND end_date >= $1
        AND (max_uses IS NULL OR current_uses < max_uses)
      ORDER BY end_date ASC`,
    [t]
  );
  return r.rows;
}

/**
 * 給購課頁 call：傳入 (originalPrice + scope + 可選 couponCode)，回傳最佳折抵。
 *   - 若有 couponCode → 嚴格驗證該代碼（必須符合 status/日期/scope/max_uses）。
 *   - 若無 couponCode → 自動從 active 且 coupon_code IS NULL 的活動中挑「折抵最大」一筆。
 */
async function previewBestDiscount({ originalPrice, courseType, venueId, periodCount = 1, couponCode = null, parentId = null }) {
  const today = new Date().toISOString().slice(0, 10);
  const op = Math.max(0, Math.round(Number(originalPrice) || 0));
  if (!op) return { originalPrice: 0, discountAmount: 0, finalPrice: 0, promotion: null };

  if (couponCode) {
    const rc = await pool.query(
      `SELECT * FROM promotions WHERE UPPER(coupon_code) = UPPER($1)`,
      [String(couponCode).trim()]
    );
    if (rc.rowCount === 0) {
      const err = new Error('折價券代碼無效');
      err.code = 'COUPON_INVALID'; throw err;
    }
    const p = rc.rows[0];
    if (p.status !== 'active') {
      const err = new Error('折價券尚未啟用'); err.code = 'COUPON_NOT_ACTIVE'; throw err;
    }
    if (!isWithinWindow(p, today)) {
      const err = new Error('折價券已過期或尚未開始'); err.code = 'COUPON_OUT_OF_WINDOW'; throw err;
    }
    if (p.max_uses != null && p.current_uses >= p.max_uses) {
      const err = new Error('折價券使用次數已用盡'); err.code = 'COUPON_EXHAUSTED'; throw err;
    }
    if (!matchScope(p, { courseType, venueId, periodCount })) {
      const err = new Error('折價券不適用本次購課'); err.code = 'COUPON_OUT_OF_SCOPE'; throw err;
    }
    if (p.eligible_parent_id && p.eligible_parent_id !== parentId) {
      const err = new Error('此折價券僅限指定家長使用'); err.code = 'COUPON_NOT_OWNER'; throw err;
    }
    const discount = computeDiscount(p, op);
    return {
      originalPrice: op,
      discountAmount: discount,
      finalPrice: op - discount,
      promotion: { id: p.id, name: p.name, description: p.description, type: p.type, coupon_code: p.coupon_code },
    };
  }

  const candidates = await listActivePromotions({ today });
  let best = null;
  let bestDiscount = 0;
  for (const p of candidates) {
    if (p.coupon_code) continue; // 需要代碼的不自動套用
    if (p.eligible_parent_id) continue; // 私人券不能自動套用
    if (!matchScope(p, { courseType, venueId, periodCount })) continue;
    const d = computeDiscount(p, op);
    if (d > bestDiscount) { best = p; bestDiscount = d; }
  }
  if (!best) return { originalPrice: op, discountAmount: 0, finalPrice: op, promotion: null };
  return {
    originalPrice: op,
    discountAmount: bestDiscount,
    finalPrice: op - bestDiscount,
    promotion: { id: best.id, name: best.name, description: best.description, type: best.type, coupon_code: null },
  };
}

/**
 * 紀錄優惠使用（寫入 promotion_usages，並 +1 current_uses）。
 * 通常在報名/結帳交易內呼叫；可傳入既有 client 共用 transaction。
 */
async function recordUsage({ promotionId, parentId, coursePeriodId, adminEnrollmentId, originalPrice, discountAmount, finalPrice }, client) {
  if (!promotionId) return null;
  const db = client || pool;
  // 套用前的最後一道防線：在交易內 lock 該筆 promotion 並驗證 status / 使用量
  // 在 lock 同時用 SQL CURRENT_DATE 做日期內含比較（避免 JS Date 把 end_date 當午夜）
  const lock = await db.query(
    `SELECT status, max_uses, current_uses, eligible_parent_id,
            (start_date IS NULL OR start_date <= CURRENT_DATE) AS started,
            (end_date   IS NULL OR end_date   >= CURRENT_DATE) AS not_expired
       FROM promotions WHERE id = $1 FOR UPDATE`,
    [promotionId]
  );
  if (!lock.rowCount) {
    const err = new Error('折價券不存在'); err.code = 'COUPON_INVALID'; throw err;
  }
  const row = lock.rows[0];
  if (row.status !== 'active') {
    const err = new Error('折價券尚未啟用'); err.code = 'COUPON_NOT_ACTIVE'; throw err;
  }
  if (!row.started) {
    const err = new Error('折價券尚未開始'); err.code = 'COUPON_NOT_STARTED'; throw err;
  }
  if (!row.not_expired) {
    const err = new Error('折價券已過期'); err.code = 'COUPON_EXPIRED'; throw err;
  }
  if (row.max_uses != null && row.current_uses >= row.max_uses) {
    const err = new Error('折價券使用次數已用盡'); err.code = 'COUPON_EXHAUSTED'; throw err;
  }
  if (row.eligible_parent_id && row.eligible_parent_id !== parentId) {
    const err = new Error('此折價券僅限指定家長使用'); err.code = 'COUPON_NOT_OWNER'; throw err;
  }
  const r = await db.query(
    `INSERT INTO promotion_usages (promotion_id, parent_id, course_period_id, admin_enrollment_id,
        original_price, discount_amount, final_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [promotionId, parentId || null, coursePeriodId || null, adminEnrollmentId || null,
     originalPrice, discountAmount, finalPrice]
  );
  await db.query(`UPDATE promotions SET current_uses = current_uses + 1 WHERE id = $1`, [promotionId]);
  return r.rows[0];
}

module.exports = {
  listActivePromotions,
  previewBestDiscount,
  recordUsage,
  // 內部 helper 也匯出方便測試
  _internal: { matchScope, computeDiscount },
};
