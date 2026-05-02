/**
 * LIFF / 公開優惠 API
 *  GET  /api/promotions                → 進行中、自動套用的優惠（首頁橫幅 + R05 共用）
 *  POST /api/promotions/preview        → 報名頁試算：傳 { originalPrice, courseType, venueId, periodCount?, couponCode? }
 *
 * 套用後寫入 promotion_usages 由 enrollments 流程在交易內呼叫 services.recordUsage（不在這條路由）
 */
const express = require('express');
const promotions = require('../services/promotions');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await promotions.listActivePromotions();
    // 對 LIFF 首頁簡化欄位（只回自動套用的；coupon code 不公開）
    const out = rows
      .filter((p) => !p.coupon_code)
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

router.post('/preview', async (req, res) => {
  try {
    const { originalPrice, courseType, venueId, periodCount, couponCode } = req.body || {};
    if (!originalPrice || !courseType) {
      return res.status(400).json({ error: 'originalPrice / courseType 必填' });
    }
    const r = await promotions.previewBestDiscount({
      originalPrice: Number(originalPrice),
      courseType: Number(courseType),
      venueId: venueId || null,
      periodCount: periodCount ? Number(periodCount) : 1,
      couponCode: couponCode || null,
    });
    res.json(r);
  } catch (err) {
    if (err.code && err.code.startsWith('COUPON_')) {
      // 防止折價券枚舉：對外一律回相同訊息與通用 code，詳情只記在伺服器端
      console.warn('[coupon preview rejected]', err.code, err.message);
      return res.status(400).json({ error: '折價券無法使用，請確認代碼是否正確或仍在使用期間', code: 'COUPON_INVALID' });
    }
    console.error('[promotions preview]', err);
    res.status(500).json({ error: 'preview failed' });
  }
});

module.exports = router;
