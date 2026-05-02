import React from 'react';

const TONE_CLS = {
  primary: 'bg-brand-primary text-white',
  teal:    'bg-brand-teal text-white',
  green:   'bg-brand-green text-white',
  amber:   'bg-brand-amber text-white',
  gold:    'bg-brand-gold text-white',
  error:   'bg-brand-error text-white',
  errorSoft: 'bg-brand-error-soft text-brand-error-strong',
  gray:    'bg-gray-200 text-gray-700',
};

export default function StatusBadge({ tone = 'gray', children, className = '' }) {
  const cls = TONE_CLS[tone] || TONE_CLS.gray;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls} ${className}`}>
      {children}
    </span>
  );
}
