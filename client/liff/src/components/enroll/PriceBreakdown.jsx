import React from 'react';
import { Section, Row } from './EnrollmentParts';
import { formatTWD } from '../../utils/format';

export default function PriceBreakdown({ pricing, multiplier }) {
  return (
    <Section title="費用明細">
      <Row label="原始費用" value={formatTWD(pricing.base)} />
      <Row
        label={`套用係數 ${Math.round((multiplier || 1) * 100)}%`}
        value={formatTWD(pricing.afterMultiplier)}
      />
      {pricing.promo && (
        <Row
          label={`優惠：${pricing.promo.title}`}
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
