/**
 * LIFF / 公開優惠 API
 *  GET  /api/promotions                → 進行中、自動套用的優惠（首頁橫幅 + R05 共用）
 *  POST /api/promotions/preview        → 報名頁試算：傳 { originalPrice, courseType, venueId, periodCount?, couponCode?, coachId? }
 *
 * 套用後寫入 promotion_usages 由 enrollments 流程在交易內呼叫 services.recordUsage（不在這條路由）
 */
const express = require('express');
const promotions = require('../services/promotions');
const { pool } = require('../models/db');
const { optionalParent } = require('../middlewares/parentAuth');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 教練加成一律以 DB 為權威值（與 enrollments 成交流程同源）：優先用 coachId 查 coaches.pricing_multiplier，
// 查不到時才退回前端傳入的 coachMultiplier（相容舊版前端）。避免因前端漏傳/過時而誤判「不適用」。
async function resolveCoachMultiplier(coachId, clientMultiplier) {
  if (coachId && UUID_RE.test(String(coachId))) {
    // 查詢失敗不可吞成 null：null 會被呼叫端當成「教練係數尚未設定」回 409，
    // 家長看到的是錯的原因（以為教練沒設定好），櫃台也會往錯的方向查。
    // DB 出錯就讓它往上丟，由路由統一回 500（#12 假成功稽核）。
    const r = await pool.query(`SELECT COALESCE(s.multiplier, c.pricing_multiplier) AS pricing_multiplier
      FROM coaches c LEFT JOIN admin_staff s ON s.id = c.ragic_employee_id WHERE c.id = $1`, [String(coachId)]);
    const value = r.rows[0]?.pricing_multiplier == null ? null : Number(r.rows[0].pricing_multiplier);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return clientMultiplier != null ? Number(clientMultiplier) : null;
}

router.get('/', async (req, res) => {
  try {
    const rows = await promotions.listActivePromotions();
    // 對 LIFF 首頁簡化欄位（只回自動套用的；coupon code 不公開）
    const out = rows
      .filter((p) => !p.coupon_code && p.show_on_parent_home !== false)
      .map((p) => ({
        id: p.id,
        title: p.name,
        description: p.description,
        type: p.type,
        value: Number(p.discount_value),
        is_auto_apply: true,
        threshold: p.min_threshold_type
          ? { type: p.min_threshold_type, value: p.min_threshold_value }
          : null,
        expires_at: p.end_date,
      }));
    res.json(out);
  } catch (err) {
    console.error('[promotions list]', err);
    res.status(500).json({ error: 'load promotions failed' });
  }
});

router.post('/preview', optionalParent, async (req, res) => {
  try {
    const { originalPrice, courseType, venueId, periodCount, couponCode, coachMultiplier, coachId } = req.body || {};
    if (originalPrice === null || originalPrice === undefined || originalPrice === '' || !Number.isFinite(Number(originalPrice)) || Number(originalPrice) < 0 || !courseType) {
      return res.status(400).json({ error: 'originalPrice / courseType 必填' });
    }
    const effectiveMultiplier = await resolveCoachMultiplier(coachId, coachMultiplier);
    if (coachId && (!Number.isFinite(effectiveMultiplier) || effectiveMultiplier <= 0)) {
      return res.status(409).json({ error: '教練修課係數尚未設定', code: 'COACH_MULTIPLIER_UNAVAILABLE' });
    }
    const r = await promotions.previewBestDiscount({
      originalPrice: Number(originalPrice),
      courseType: Number(courseType),
      venueId: venueId || null,
      periodCount: periodCount ? Number(periodCount) : 1,
      couponCode: couponCode || null,
      parentId: req.parent?.id || null,
      coachMultiplier: effectiveMultiplier,
    });
    res.json(r);
  } catch (err) {
    if (err.code && err.code.startsWith('COUPON_')) {
      // 防止折價券枚舉：一般券錯誤維持通用訊息；額度上限採用後端明確提示。
      console.warn('[coupon preview rejected]', err.code, err.message);
      return res.status(400).json({
        error: err.publicMessage ? err.message : '折價券無法使用，請確認代碼是否正確或仍在使用期間',
        code: err.publicMessage ? err.code : 'COUPON_INVALID',
      });
    }
    console.error('[promotions preview]', err);
    res.status(500).json({ error: 'preview failed' });
  }
});

module.exports = router;
