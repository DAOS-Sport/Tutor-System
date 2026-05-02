import { useMemo } from 'react';

export default function useEnrollmentPricing(bootData) {
  return useMemo(() => {
    if (!bootData) return null;
    const base = bootData.basePrice;
    const afterMultiplier = Math.round(base * (bootData.coach?.multiplier || 1));
    const autoPromo = (bootData.promos || []).find((p) => p.is_auto_apply);
    let final = afterMultiplier;
    let discount = 0;
    if (autoPromo) {
      final = Math.round(afterMultiplier * autoPromo.value);
      discount = afterMultiplier - final;
    }
    return { base, afterMultiplier, final, discount, promo: autoPromo };
  }, [bootData]);
}
