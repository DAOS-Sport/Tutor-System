/**
 * 優惠折扣的顯示文字。家長端首頁與教練端今日頁共用同一份——
 * 兩邊各寫一份遲早會漂移，家長看到「9 折」教練看到「0.9 折」是最糟的情況。
 *
 * PERCENTAGE 存的是乘數（0.9 = 9 折），且必須 <= 1 才是合理的折扣；
 * 超過 1 代表資料有問題，不要硬算出一個看起來很正常的數字。
 */
export function promotionValueLabel(promotion) {
  const value = Number(promotion?.value ?? promotion?.discount_value);
  if (!Number.isFinite(value) || value <= 0) return '優惠詳情請洽櫃檯';
  if (promotion?.type === 'PERCENTAGE' && value <= 1) {
    return `${Number((value * 10).toFixed(1))} 折`;
  }
  if (promotion?.type === 'FIXED_AMOUNT') {
    return `現折 NT$ ${Math.round(value).toLocaleString('zh-TW')}`;
  }
  return '優惠詳情請洽櫃檯';
}