import { useEffect, useMemo, useState } from 'react';
import { promotionsApi } from '../api/promotions';

/**
 * 純計算 hook：base + afterMultiplier，並 expose `applyPreview` 接後端試算結果。
 * - 不再讀 bootData.promos（改由 promotionsApi.preview 直接取最佳折抵 / 折價券）
 * - 回傳 final / discount / promo 給 PriceBreakdown / EnrollmentSummary 使用
 */
export default function useEnrollmentPricing(bootData, { courseType, venueId, couponCode, studentCount = 1, periodCount = 1 } = {}) {
  // 單期單生價（base × 教練倍率），與後端 unitPrice 一致。
  const unitPrice = useMemo(() => {
    if (!bootData) return null;
    return Math.round(bootData.basePrice * (bootData.coach?.multiplier || 1));
  }, [bootData]);

  // U10：小計 = 單生價 × 學生數 × 期數
  const qty = Math.max(1, studentCount) * Math.max(1, periodCount);
  const subtotal = unitPrice == null ? null : unitPrice * qty;

  const [preview, setPreview] = useState({ discount: 0, promo: null, error: null, loading: false });

  useEffect(() => {
    if (subtotal == null || !courseType) return;
    let alive = true;
    setPreview((s) => ({ ...s, loading: true, error: null }));
    promotionsApi
      .preview({
        originalPrice: subtotal,
        courseType,
        venueId,
        periodCount,
        couponCode: couponCode || undefined,
      })
      .then((r) => {
        if (!alive) return;
        setPreview({ discount: r.discountAmount || 0, promo: r.promotion || null, error: null, loading: false });
      })
      .catch((e) => {
        if (!alive) return;
        const msg = e?.response?.data?.error || e?.message || '優惠試算失敗';
        setPreview({ discount: 0, promo: null, error: couponCode ? msg : null, loading: false });
      });
    return () => { alive = false; };
  }, [subtotal, courseType, venueId, couponCode, periodCount]);

  return useMemo(() => {
    if (unitPrice == null) return null;
    return {
      base: bootData.basePrice,
      unitPrice,                 // 單期單生價
      studentCount: Math.max(1, studentCount),
      periodCount: Math.max(1, periodCount),
      subtotal,                  // 折扣前小計
      afterMultiplier: subtotal, // 向後相容（舊欄位 = 折扣前小計）
      discount: preview.discount,
      final: subtotal - preview.discount,
      promo: preview.promo,
      previewError: preview.error,
      previewLoading: preview.loading,
    };
  }, [bootData, unitPrice, subtotal, studentCount, periodCount, preview]);
}
