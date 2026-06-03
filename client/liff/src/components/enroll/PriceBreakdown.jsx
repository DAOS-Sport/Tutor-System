import React from 'react';
import { Section, Row } from './EnrollmentParts';
import { formatTWD } from '../../utils/format';

export default function PriceBreakdown({ pricing, multiplier }) {
  const qtyLabel = `${pricing.studentCount} 生${pricing.periodCount > 1 ? ` × ${pricing.periodCount} 期` : ''}`;
  return (
    <Section title="費用明細">
      <Row label="原始費用（單期單生）" value={formatTWD(pricing.base)} />
      <Row
        label={`套用係數 ${Math.round((multiplier || 1) * 100)}%`}
        value={formatTWD(pricing.unitPrice)}
      />
      <Row label={`數量（${qtyLabel}）`} value={`小計 ${formatTWD(pricing.subtotal)}`} />
      {pricing.promo && pricing.discount > 0 && (
        <Row
          label={`優惠：${pricing.promo.name || pricing.promo.title}${pricing.promo.coupon_code ? ` (${pricing.promo.coupon_code})` : ''}`}
          value={`-${formatTWD(pricing.discount)}`}
          valueCls="text-brand-green"
        />
      )}
      <div className="mt-2 flex items-baseline justify-between border-t border-gray-100 pt-2">
        <span className="text-sm font-bold text-gray-700">應繳金額</span>
        <span className="text-xl font-bold text-brand-primary">{formatTWD(pricing.final)}</span>
      </div>
    </Section>
  );
}
