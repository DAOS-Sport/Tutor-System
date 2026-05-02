/**
 * 優惠活動計算服務（資料隔離核心）
 * 課程期只記錄 original_price / final_price
 * 所有優惠計算在此服務完成，結果寫入 promotion_usages
 */
const { pool } = require('../models/db');

/**
 * 查詢符合條件的優惠活動
 * @param {object} opts - { courseType, venueId, periodCount, purchaseDate }
 * @returns {Array} 符合條件的優惠活動清單
 */
async function findApplicablePromotions({ courseType, venueId, periodCount, purchaseDate }) {
  const now = purchaseDate || new Date().toISOString().slice(0, 10);
  const res = await pool.query(
    `SELECT * FROM promotions
     WHERE is_active = true
       AND start_date <= $1
       AND end_date   >= $1
       AND (max_uses IS NULL OR current_uses < max_uses)
     ORDER BY discount_value DESC`,
    [now]
  );
  return res.rows.filter(p => {
    const typeOk  = !p.applicable_course_types || p.applicable_course_types.includes(courseType);
    const venueOk = !p.applicable_venue_ids   || p.applicable_venue_ids.includes(venueId);
    const threshOk = !p.min_threshold_value
      || (p.min_threshold_type === 'PERIOD_COUNT' && periodCount >= p.min_threshold_value);
    return typeOk && venueOk && threshOk;
  });
}

/**
 * 計算最終費用（取最優惠的單一活動）
 * @returns { originalPrice, discountAmount, finalPrice, promotionId }
 */
async function calculateFinalPrice(originalPrice, opts) {
  const promotions = await findApplicablePromotions(opts);
  if (promotions.length === 0) {
    return { originalPrice, discountAmount: 0, finalPrice: originalPrice, promotionId: null };
  }
  const best = promotions[0];
  let discountAmount = 0;
  if (best.type === 'PERCENTAGE') {
    discountAmount = Math.round(originalPrice * (1 - parseFloat(best.discount_value)));
  } else if (best.type === 'FIXED_AMOUNT') {
    discountAmount = Math.min(parseFloat(best.discount_value), originalPrice);
  }
  return {
    originalPrice,
    discountAmount,
    finalPrice: originalPrice - discountAmount,
    promotionId: best.id,
  };
}

/**
 * 驗證並套用折價券代碼
 */
async function applyCouponCode(couponCode, originalPrice, opts) {
  const res = await pool.query(
    `SELECT * FROM promotions WHERE coupon_code = $1 AND is_active = true AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE`,
    [couponCode]
  );
  if (res.rows.length === 0) throw new Error('折價券代碼無效或已過期');
  const promo = res.rows[0];
  let discountAmount = 0;
  if (promo.type === 'PERCENTAGE') {
    discountAmount = Math.round(originalPrice * (1 - parseFloat(promo.discount_value)));
  } else if (promo.type === 'FIXED_AMOUNT') {
    discountAmount = Math.min(parseFloat(promo.discount_value), originalPrice);
  }
  return { originalPrice, discountAmount, finalPrice: originalPrice - discountAmount, promotionId: promo.id };
}

/**
 * 記錄優惠使用（寫入 promotion_usages）
 */
async function recordUsage({ promotionId, coursePeriodId, originalPrice, discountAmount, finalPrice }, client) {
  if (!promotionId) return;
  const db = client || pool;
  await db.query(
    `INSERT INTO promotion_usages (promotion_id, course_period_id, original_price, discount_amount, final_price)
     VALUES ($1, $2, $3, $4, $5)`,
    [promotionId, coursePeriodId, originalPrice, discountAmount, finalPrice]
  );
  await db.query(`UPDATE promotions SET current_uses = current_uses + 1 WHERE id = $1`, [promotionId]);
}

module.exports = { findApplicablePromotions, calculateFinalPrice, applyCouponCode, recordUsage };
