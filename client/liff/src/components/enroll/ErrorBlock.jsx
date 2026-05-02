import React from 'react';

export default function ErrorBlock({ message, onBack }) {
  return (
    <div className="px-4 py-8 text-center">
      <div className="mb-3 text-sm text-brand-error">{message}</div>
      <button
        type="button"
        onClick={onBack}
        className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white"
      >
        回首頁
      </button>
    </div>
  );
}
