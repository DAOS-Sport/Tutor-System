import React from 'react';

export default function LoadingSpinner({ label = '載入中…', fullPage = false }) {
  const spinner = (
    <div className="flex flex-col items-center gap-3 text-brand-primary">
      <div
        className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary/20 border-t-brand-primary"
        role="status"
        aria-label={label}
      />
      {label && <span className="text-sm font-medium">{label}</span>}
    </div>
  );
  if (fullPage) return <div className="flex min-h-[60vh] items-center justify-center">{spinner}</div>;
  return <div className="flex items-center justify-center py-6">{spinner}</div>;
}
