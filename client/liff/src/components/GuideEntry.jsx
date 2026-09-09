import React from 'react';
import { Link } from 'react-router-dom';

export default function GuideEntry({ role }) {
  return (
    <Link data-guide-entry to={role === 'coach' ? '/coach/guide' : '/guide'}
      className={`mb-5 flex w-full items-center justify-between p-4 active:opacity-90 ${role === 'coach'
        ? 'rounded-xl border border-gray-200 bg-white text-brand-primary'
        : 'rounded-2xl bg-brand-teal text-white'}`}>
      <div>
        <div className="flex items-center gap-1.5 text-sm font-bold">
          <svg className={role === 'coach' ? 'text-brand-teal' : undefined} aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z" strokeLinejoin="round" />
          </svg>
          教學指南
        </div>
        <div className={`mt-0.5 text-[11px] ${role === 'coach' ? 'text-gray-500' : 'text-white/80'}`}>{role === 'coach' ? '排課、授課與記錄，隨時查看' : '報名、付款與簽到，隨時查看'}</div>
      </div>
      <span aria-hidden="true">›</span>
    </Link>
  );
}
