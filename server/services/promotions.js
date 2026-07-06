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

// 取台灣時區「今天」的曆日字串（YYYY-MM-DD）。DB pool 連線一律 SET TIME ZONE 'Asia/Taipei'
// （見 models/db.js），故 recordUsage 的 FOR UPDATE 覆核用 SQL CURRENT_DATE＝台灣曆日；
// preview / list 的 today 必須同步採台灣曆日，否則台灣 00:00–08:00（此時 UTC 仍是前一日）
// 兩者會不一致 → 折扣「顯示得到卻被 recordUsage 拒絕」。
// 注意：process TZ / new Date().toISOString() 皆無法修正此問題，須明確指定 timeZone。
function todayTaipei() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
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
  const t = today || todayTaipei();
  const r = await pool.query(
    `SELECT id, name, description, type, discount_value, min_threshold_type, min_threshold_value,
            applicable_course_types, applicable_venue_ids, coupon_code, eligible_parent_id,
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
  const today = todayTaipei();
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

/**
 * 退回優惠使用（退費 / 取消時呼叫）：以 admin_enrollment_id 刪除 promotion_usages，
 * 並依實刪筆數把對應 promotions.current_uses 減回（GREATEST 防負）。
 *  - 必須傳入退費 / 取消交易的 client，與狀態變更同生共死。
 *  - 冪等：找不到 usage（刪 0 筆）→ 不遞減、不報錯，可安全重複呼叫。
 */
async function revertUsage({ adminEnrollmentId }, client) {
  if (!adminEnrollmentId) return { reverted: 0 };
  const db = client || pool;
  const del = await db.query(
    `DELETE FROM promotion_usages WHERE admin_enrollment_id = $1 RETURNING promotion_id`,
    [adminEnrollmentId]
  );
  if (!del.rowCount) return { reverted: 0 };
  // 同一報名理論上只掛一筆 usage；仍依 promotion 分組彙總，避免多筆時遞減錯配。
  const counts = new Map();
  for (const r of del.rows) counts.set(r.promotion_id, (counts.get(r.promotion_id) || 0) + 1);
  for (const [promotionId, n] of counts) {
    await db.query(
      `UPDATE promotions SET current_uses = GREATEST(0, current_uses - $2) WHERE id = $1`,
      [promotionId, n]
    );
  }
  return { reverted: del.rowCount };
}

module.exports = {
  listActivePromotions,
  previewBestDiscount,
  recordUsage,
  revertUsage,
  // 內部 helper 也匯出方便測試
  _internal: { matchScope, computeDiscount },
};
