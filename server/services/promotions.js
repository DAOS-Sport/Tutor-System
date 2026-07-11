/**
 * 優惠活動計算服務（資料隔離核心）
 * - 課程期只記錄 original_price / final_price
 * - 所有優惠計算在此服務完成，結果寫入 promotion_usages
 *
 * Phase 6（上）schema：
 *   promotions: type ('PERCENTAGE'|'FIXED_AMOUNT'), discount_value (NUMERIC),
 *               min_threshold_type ('PERIOD_COUNT'), min_threshold_value,
 *               applicable_course_types INTEGER[], applicable_venue_ids VARCHAR[],
 *               coupon_code (NULL = 自動套用), status, start/end date, max_uses,
 *               platform_total_period_cap, parent_period_cap, current_period_uses
 */
const { pool } = require('../models/db');

// start_date / end_date 為 TIMESTAMPTZ（絕對時刻）→ 直接比當前時刻，含端點（迄日已存至 23:59:59）。
function isWithinWindow(p, now = Date.now()) {
  const start = new Date(p.start_date).getTime();
  const end = new Date(p.end_date).getTime();
  return start <= now && end >= now;
}

function matchScope(p, { courseType, venueId, periodCount, coachMultiplier }) {
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
  // 教練加成％篩選：空/NULL = 不限；否則教練加成須在名單內（NUMERIC 由 pg 回字串，兩邊 Number 後比值）
  const multiplierOk =
    !p.applicable_coach_multipliers ||
    p.applicable_coach_multipliers.length === 0 ||
    (coachMultiplier != null &&
      p.applicable_coach_multipliers.some((m) => Number(m) === Number(coachMultiplier)));
  return typeOk && venueOk && threshOk && multiplierOk;
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

function normalizeRequestPeriods(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function hasPlatformPeriodCapacity(p, requestPeriods = 1) {
  if (p.platform_total_period_cap == null) return true;
  return (Number(p.current_period_uses) || 0) + normalizeRequestPeriods(requestPeriods) <= Number(p.platform_total_period_cap);
}

function quotaError(message, code = 'COUPON_EXHAUSTED') {
  const err = new Error(message);
  err.code = code;
  err.publicMessage = true;
  return err;
}

async function getParentPeriodUses(db, promotionId, parentId) {
  if (!parentId) return 0;
  const r = await db.query(
    `SELECT COALESCE(SUM(used_periods), 0)::int AS used_periods
       FROM promotion_usages
      WHERE promotion_id = $1 AND parent_id = $2`,
    [promotionId, parentId]
  );
  return Number(r.rows[0]?.used_periods) || 0;
}

/**
 * 列出 LIFF / R05 可見的「目前進行中」自動套用優惠（不含折價券需代碼者）。
 */
async function listActivePromotions() {
  // 起迄為 TIMESTAMPTZ → 直接以 NOW()（絕對時刻）判定是否在檔期內（含 23:59:59 端點）。
  const r = await pool.query(
    `SELECT id, name, description, type, discount_value, min_threshold_type, min_threshold_value,
            applicable_course_types, applicable_venue_ids, applicable_coach_multipliers,
            show_on_parent_home, coupon_code, eligible_parent_id,
            start_date, end_date, max_uses, current_uses,
            platform_total_period_cap, parent_period_cap, current_period_uses
       FROM promotions
      WHERE status = 'active'
        AND start_date <= NOW() AND end_date >= NOW()
        AND (max_uses IS NULL OR current_uses < max_uses)
        AND (platform_total_period_cap IS NULL OR current_period_uses < platform_total_period_cap)
      ORDER BY end_date ASC`
  );
  return r.rows;
}

/**
 * 給購課頁 call：傳入 (originalPrice + scope + 可選 couponCode)，回傳最佳折抵。
 *   - 若有 couponCode → 嚴格驗證該代碼（必須符合 status/日期/scope/max_uses）。
 *   - 若無 couponCode → 自動從 active 且 coupon_code IS NULL 的活動中挑「折抵最大」一筆。
 */
async function previewBestDiscount({ originalPrice, courseType, venueId, periodCount = 1, couponCode = null, parentId = null, coachMultiplier = null }) {
  const op = Math.max(0, Math.round(Number(originalPrice) || 0));
  const requestPeriods = normalizeRequestPeriods(periodCount);
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
    if (!isWithinWindow(p)) {
      const err = new Error('折價券已過期或尚未開始'); err.code = 'COUPON_OUT_OF_WINDOW'; throw err;
    }
    if (p.max_uses != null && p.current_uses >= p.max_uses) {
      const err = new Error('折價券使用次數已用盡'); err.code = 'COUPON_EXHAUSTED'; throw err;
    }
    if (!hasPlatformPeriodCapacity(p, requestPeriods)) {
      throw quotaError('該活動優惠總額度已達上限');
    }
    if (p.parent_period_cap != null && parentId) {
      const usedPeriods = await getParentPeriodUses(pool, p.id, parentId);
      if (usedPeriods + requestPeriods > Number(p.parent_period_cap)) {
        throw quotaError('您已達到該優惠活動的個人使用上限');
      }
    }
    if (!matchScope(p, { courseType, venueId, periodCount, coachMultiplier })) {
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

  const candidates = await listActivePromotions();
  let best = null;
  let bestDiscount = 0;
  for (const p of candidates) {
    if (p.coupon_code) continue; // 需要代碼的不自動套用
    if (p.eligible_parent_id) continue; // 私人券不能自動套用
    if (!matchScope(p, { courseType, venueId, periodCount, coachMultiplier })) continue;
    if (!hasPlatformPeriodCapacity(p, requestPeriods)) continue;
    if (p.parent_period_cap != null && parentId) {
      const usedPeriods = await getParentPeriodUses(pool, p.id, parentId);
      if (usedPeriods + requestPeriods > Number(p.parent_period_cap)) continue;
    }
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
 * 紀錄優惠使用（寫入 promotion_usages，並 +1 current_uses / +N current_period_uses）。
 * 通常在報名/結帳交易內呼叫；可傳入既有 client 共用 transaction。
 */
async function recordUsage({
  promotionId,
  parentId,
  coursePeriodId,
  adminEnrollmentId,
  originalPrice,
  discountAmount,
  finalPrice,
  periodCount,
  requestPeriods,
}, client) {
  if (!promotionId) return null;
  const db = client || pool;
  const usedPeriods = normalizeRequestPeriods(requestPeriods ?? periodCount);
  // 套用前的最後一道防線：在交易內 lock 該筆 promotion 並驗證 status / 使用量
  // 起迄為 TIMESTAMPTZ → 以 NOW()（絕對時刻）做內含比較（迄日已含至 23:59:59）。
  const lock = await db.query(
    `SELECT status, max_uses, current_uses, eligible_parent_id,
            platform_total_period_cap, parent_period_cap, current_period_uses,
            (start_date IS NULL OR start_date <= NOW()) AS started,
            (end_date   IS NULL OR end_date   >= NOW()) AS not_expired
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
  if (row.platform_total_period_cap != null
      && (Number(row.current_period_uses) || 0) + usedPeriods > Number(row.platform_total_period_cap)) {
    throw quotaError('該活動優惠總額度已達上限');
  }
  if (row.parent_period_cap != null) {
    if (!parentId) {
      const err = new Error('此折價券需綁定家長使用'); err.code = 'COUPON_OUT_OF_SCOPE'; throw err;
    }
    const parentUsedPeriods = await getParentPeriodUses(db, promotionId, parentId);
    if (parentUsedPeriods + usedPeriods > Number(row.parent_period_cap)) {
      throw quotaError('您已達到該優惠活動的個人使用上限');
    }
  }
  if (row.eligible_parent_id && row.eligible_parent_id !== parentId) {
    const err = new Error('此折價券僅限指定家長使用'); err.code = 'COUPON_NOT_OWNER'; throw err;
  }
  const r = await db.query(
    `INSERT INTO promotion_usages (promotion_id, parent_id, course_period_id, admin_enrollment_id,
        original_price, discount_amount, final_price, used_periods)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [promotionId, parentId || null, coursePeriodId || null, adminEnrollmentId || null,
     originalPrice, discountAmount, finalPrice, usedPeriods]
  );
  const quotaUpdate = await db.query(
    `UPDATE promotions
        SET current_uses = current_uses + 1,
            current_period_uses = COALESCE(current_period_uses, 0) + $2
      WHERE id = $1
        AND (platform_total_period_cap IS NULL
             OR COALESCE(current_period_uses, 0) + $2 <= platform_total_period_cap)`,
    [promotionId, usedPeriods]
  );
  if (!quotaUpdate.rowCount) {
    throw quotaError('該活動優惠總額度已達上限');
  }
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
    `DELETE FROM promotion_usages
      WHERE admin_enrollment_id = $1
      RETURNING promotion_id, COALESCE(used_periods, 1)::int AS used_periods`,
    [adminEnrollmentId]
  );
  if (!del.rowCount) return { reverted: 0 };
  // 同一報名理論上只掛一筆 usage；仍依 promotion 分組彙總，避免多筆時遞減錯配。
  const counts = new Map();
  for (const r of del.rows) {
    const cur = counts.get(r.promotion_id) || { count: 0, usedPeriods: 0 };
    cur.count += 1;
    cur.usedPeriods += Number(r.used_periods) || 1;
    counts.set(r.promotion_id, cur);
  }
  for (const [promotionId, { count, usedPeriods }] of counts) {
    await db.query(
      `UPDATE promotions
          SET current_uses = GREATEST(0, current_uses - $2),
              current_period_uses = GREATEST(0, COALESCE(current_period_uses, 0) - $3)
        WHERE id = $1`,
      [promotionId, count, usedPeriods]
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
  _internal: { matchScope, computeDiscount, normalizeRequestPeriods, hasPlatformPeriodCapacity },
};
