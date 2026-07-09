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
  disabledRole: 'bg-gray-400 text-white',
};

// 全域狀態顏色規範：綠＝通過/成功/啟用、灰＝取消、紅＝退費/停用、橘＝待審核。
// 各頁面的狀態徽章應優先對應到這四類語意，而非各自挑色，才能維持全站一致。
export const STATUS_TONE = {
  success: 'green',
  cancelled: 'gray',
  danger: 'error',
  pending: 'amber',
};

export default function StatusBadge({ tone = 'gray', children, className = '', title }) {
  const cls = TONE_CLS[tone] || TONE_CLS.gray;
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls} ${className}`}>
      {children}
    </span>
  );
}
