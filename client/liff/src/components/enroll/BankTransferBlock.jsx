import React from 'react';
import { Section, Row } from './EnrollmentParts';
import { isValidLast5 } from '../../utils/format';

export default function BankTransferBlock({ venue, last5, setLast5, onCopyAccount }) {
  return (
    <Section title="轉帳資訊">
      <Row label="戶名" value={venue.account_holder} />
      <Row label="銀行" value={`${venue.bank_institution_name} ${venue.bank_branch_name}`} />
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-brand-primary/5 p-3">
        <div className="flex-1">
          <div className="text-[11px] text-gray-500">帳號</div>
          <div className="font-mono text-base font-bold text-brand-primary">
            {venue.account_number}
          </div>
        </div>
        <button
          type="button"
          onClick={onCopyAccount}
          className="rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white active:bg-brand-primary"
        >
          一鍵複製
        </button>
      </div>

      <div className="mt-3">
        <label htmlFor="last5" className="mb-1 block text-xs font-medium text-gray-600">
          轉帳末 5 碼
        </label>
        <input
          id="last5"
          type="tel"
          inputMode="numeric"
          placeholder="5 位數字"
          value={last5}
          onChange={(e) => setLast5(e.target.value.replace(/\D/g, '').slice(0, 5))}
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
        />
        {last5 && !isValidLast5(last5) && (
          <p className="mt-1 text-xs text-brand-error">需為 5 位數字</p>
        )}
      </div>
    </Section>
  );
}
