import React from 'react';
import { Section, StudentRow } from './EnrollmentParts';

export default function PartnerLookup({
  partnerPhone,
  setPartnerPhone,
  partnerLookingUp,
  partnerLookup,
  selectedPartnerStudents,
  onLookup,
  onTogglePartner,
}) {
  return (
    <Section title="加入同組學員（其他家長名下，可選）">
      <div className="flex gap-2">
        <input
          type="tel"
          inputMode="numeric"
          placeholder="同組家長手機 09xxxxxxxx"
          value={partnerPhone}
          onChange={(e) => setPartnerPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
        />
        <button
          type="button"
          onClick={onLookup}
          disabled={partnerLookingUp}
          className="shrink-0 rounded-lg bg-brand-primary px-3 py-2 text-sm font-bold text-white active:bg-brand-teal disabled:opacity-50"
        >
          {partnerLookingUp ? '查詢中' : '查詢'}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-gray-400">
        測試手機：0922333444（李爸爸）、0933555777（陳媽媽）
      </p>

      {partnerLookup && (
        <div className="mt-3">
          <p className="mb-2 text-xs text-gray-500">
            {partnerLookup.name} 名下：
          </p>
          <div className="space-y-2">
            {partnerLookup.students.map((s) => (
              <StudentRow
                key={s.id}
                student={s}
                checked={selectedPartnerStudents.includes(s.id)}
                onToggle={() => onTogglePartner(s.id)}
              />
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
