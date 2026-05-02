import { useEffect, useMemo, useState } from 'react';
import { promotionsApi } from '../api/promotions';

/**
 * 純計算 hook：base + afterMultiplier，並 expose `applyPreview` 接後端試算結果。
 * - 不再讀 bootData.promos（改由 promotionsApi.preview 直接取最佳折抵 / 折價券）
 * - 回傳 final / discount / promo 給 PriceBreakdown / EnrollmentSummary 使用
 */
export default function useEnrollmentPricing(bootData, { courseType, venueId, couponCode, periodCount = 1 } = {}) {
  const baseStruct = useMemo(() => {
    if (!bootData) return null;
    const base = bootData.basePrice;
    const afterMultiplier = Math.round(base * (bootData.coach?.multiplier || 1));
    return { base, afterMultiplier };
  }, [bootData]);

  const [preview, setPreview] = useState({ discount: 0, promo: null, error: null, loading: false });

  useEffect(() => {
    if (!baseStruct || !courseType) return;
    let alive = true;
    setPreview((s) => ({ ...s, loading: true, error: null }));
    promotionsApi
      .preview({
        originalPrice: baseStruct.afterMultiplier,
        courseType,
        venueId,
        periodCount,
        couponCode: couponCode || undefined,
      })
      .then((r) => {
        if (!alive) return;
        setPreview({
          discount: r.discountAmount || 0,
          promo: r.promotion || null,
          error: null,
          loading: false,
        });
      })
      .catch((e) => {
        if (!alive) return;
        const msg = e?.response?.data?.error || e?.message || '優惠試算失敗';
        // 折價券錯誤 → 帶到 UI；自動套用失敗則不擋使用者，僅記錄
        setPreview({ discount: 0, promo: null, error: couponCode ? msg : null, loading: false });
      });
    return () => { alive = false; };
  }, [baseStruct, courseType, venueId, couponCode, periodCount]);

  return useMemo(() => {
    if (!baseStruct) return null;
    return {
      base: baseStruct.base,
      afterMultiplier: baseStruct.afterMultiplier,
      discount: preview.discount,
      final: baseStruct.afterMultiplier - preview.discount,
      promo: preview.promo,
      previewError: preview.error,
      previewLoading: preview.loading,
    };
  }, [baseStruct, preview]);
}
