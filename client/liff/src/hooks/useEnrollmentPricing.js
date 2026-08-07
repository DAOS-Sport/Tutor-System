import { useEffect, useMemo, useState } from 'react';
import { promotionsApi } from '../api/promotions';
import { resolveUnitPrice } from '../../../shared/coursePricing';

/**
 * 純計算 hook：base + afterMultiplier，並 expose `applyPreview` 接後端試算結果。
 * - 不再讀 bootData.promos（改由 promotionsApi.preview 直接取最佳折抵 / 折價券）
 * - 回傳 final / discount / promo 給 PriceBreakdown / EnrollmentSummary 使用
 */
export default function useEnrollmentPricing(bootData, {
  courseType,
  venueId,
  couponCode,
  studentCount = 1,
  periodCount = 1,
  orderKind = 'standard',
} = {}) {
  // 單期單生價，與後端 unitPrice 同源：該加成級距有落定明價就用明價，
  // 否則 base x 倍率。自己乘會讓畫面價與成交價不一致。
  const unitPrice = useMemo(() => {
    if (!bootData) return null;
    return resolveUnitPrice(bootData.basePrice, bootData.coach?.multiplier || 1, bootData.tierPrices);
  }, [bootData]);

  const isTrial = orderKind === 'trial';
  // U10：小計 = 單生價 × 學生數 × 期數。試上（2026-07-16 起開放多學員／多堂）
  // 同式計算：試上單堂價（每人）× 學生數 × 堂數，單價優先使用後端公開的
  // trial_price 覆寫值；最終建單仍會由伺服器重新計算。
  const sessionsPerPeriod = Math.max(1, Number(bootData?.sessionsPerPeriod) || 6);
  const trialUnitPrice = useMemo(() => {
    if (unitPrice == null) return null;
    const configured = Number(bootData?.trialPrice);
    return Number.isFinite(configured) && configured > 0
      ? Math.round(configured)
      : Math.round(unitPrice / sessionsPerPeriod);
  }, [bootData?.trialPrice, sessionsPerPeriod, unitPrice]);
  const qty = Math.max(1, studentCount) * Math.max(1, periodCount);
  const subtotal = unitPrice == null ? null : (isTrial ? trialUnitPrice : unitPrice) * qty;

  const [preview, setPreview] = useState({ discount: 0, promo: null, error: null, loading: false });

  useEffect(() => {
    if (subtotal == null || !courseType) return;
    if (isTrial) {
      setPreview({ discount: 0, promo: null, error: null, loading: false });
      return undefined;
    }
    let alive = true;
    setPreview({ discount: 0, promo: null, error: null, loading: true });
    promotionsApi
      .preview({
        originalPrice: subtotal,
        courseType,
        venueId,
        periodCount,
        couponCode: couponCode || undefined,
        coachId: bootData.coach?.id,               // 後端以此查 DB 權威加成值
        coachMultiplier: bootData.coach?.multiplier, // 相容用途：後端查不到 coachId 時的退回值
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
  }, [subtotal, courseType, venueId, couponCode, periodCount, isTrial]);

  return useMemo(() => {
    if (unitPrice == null) return null;
    return {
      base: bootData.basePrice,
      unitPrice: isTrial ? trialUnitPrice : unitPrice,
      studentCount: Math.max(1, studentCount),
      periodCount: Math.max(1, periodCount),
      isTrial,
      subtotal,                  // 折扣前小計
      afterMultiplier: subtotal, // 向後相容（舊欄位 = 折扣前小計）
      discount: preview.discount,
      final: subtotal - preview.discount,
      promo: preview.promo,
      previewError: preview.error,
      previewLoading: preview.loading,
    };
  }, [bootData, unitPrice, trialUnitPrice, subtotal, studentCount, periodCount, preview, isTrial]);
}
