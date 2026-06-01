import React, { useRef, useState } from 'react';
import { Section, Row } from './EnrollmentParts';
import { isValidLast5 } from '../../utils/format';

export default function BankTransferBlock({
  venue, last5, setLast5, onCopyAccount,
  proofUrl, proofUploading, onSelectProof,
}) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null);

  async function handleFile(file) {
    if (!file) return;
    const ok = await onSelectProof(file);
    if (ok) {
      setPreview(URL.createObjectURL(file));
    } else {
      setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function handleReset(e) {
    e.stopPropagation();
    setPreview(null);
    onSelectProof(null);
    if (fileRef.current) fileRef.current.value = '';
  }

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

      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium text-gray-600">
          匯款／轉帳證明 <span className="text-brand-error">*</span>
          <span className="ml-1 font-normal text-gray-400">（JPG / PNG，≤ 5MB）</span>
        </label>
        <div
          className={`relative flex min-h-24 flex-col items-center justify-center rounded-lg border-2 border-dashed p-3 transition ${
            proofUrl ? 'border-brand-teal bg-brand-teal/5' : 'cursor-pointer border-gray-300'
          }`}
          onClick={() => !proofUrl && !proofUploading && fileRef.current?.click()}
        >
          {preview ? (
            <>
              <img src={preview} alt="證明預覽" className="max-h-40 rounded-lg object-contain" />
              <button
                type="button"
                className="mt-2 text-xs text-gray-500 underline active:text-brand-error"
                onClick={handleReset}
              >
                重新選擇
              </button>
            </>
          ) : (
            <div className="text-center text-sm text-gray-400">
              <div className="mb-1 text-2xl">📄</div>
              <div>{proofUploading ? '上傳中…' : '點此上傳匯款證明'}</div>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
        {proofUrl && <p className="mt-1 text-xs text-brand-green">✓ 已上傳證明</p>}
      </div>
    </Section>
  );
}
