import React from 'react';
import { formatTWD, formatTWDate, paymentStatusColor, paymentStatusLabel, courseTypeLabel } from '../utils/format';

/**
 * 兩種模式：
 *  - variant="catalog"：首頁三組別卡片（display only + CTA）
 *  - variant="period"：「我的課程」用，顯示已開通/待對帳的課程期
 */
export default function CourseCard({ variant = 'period', period, type, onClick, ctaLabel = '立即報名' }) {
  if (variant === 'catalog') {
    return (
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="bg-brand-primary px-4 py-3 text-white">
          <div className="text-base font-bold">{type.title}</div>
          <div className="text-xs opacity-90">{type.subtitle}</div>
        </div>
        <div className="p-4">
          <p className="mb-3 text-sm text-gray-600">{type.description}</p>
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-xs text-gray-500">每期 6 堂</span>
            <span className="text-lg font-bold text-brand-primary">起 {formatTWD(type.basePrice)}</span>
          </div>
          <button
            type="button"
            onClick={onClick}
            className="w-full rounded-lg bg-brand-teal py-2.5 text-sm font-bold text-white active:bg-brand-primary"
          >
            {ctaLabel}
          </button>
        </div>
      </div>
    );
  }

  // variant === 'period'
  const pct = period.total_sessions
    ? Math.min(100, Math.round((period.used_sessions / period.total_sessions) * 100))
    : 0;
  const studentNames = (period.students || []).map((s) => s.name).join('、');

  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm active:scale-[0.99]"
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-brand-primary/10 px-2 py-0.5 text-xs font-medium text-brand-primary">
              {courseTypeLabel(period.course_type)}
            </span>
            {period.coach?.is_senior && (
              <span className="rounded-md bg-brand-gold/15 px-2 py-0.5 text-xs font-medium text-brand-gold">
                資深教練
              </span>
            )}
            {period.is_group_shared && (
              <span className="rounded-md bg-brand-teal/15 px-2 py-0.5 text-xs font-medium text-brand-teal">
                團購共享
              </span>
            )}
          </div>
          <h3 className="mt-1 truncate text-base font-bold text-gray-900">
            {period.coach?.name} · {period.venue?.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-gray-500">學員：{studentNames || '—'}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${paymentStatusColor(period.payment_status)}`}>
          {paymentStatusLabel(period.payment_status)}
        </span>
      </div>

      <div className="mt-2 mb-1 flex items-center justify-between text-xs text-gray-600">
        <span>
          堂數進度 <span className="font-bold text-brand-primary">{period.used_sessions}/{period.total_sessions}</span>
        </span>
        <span>到期 {formatTWDate(period.expires_at)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className="h-full rounded-full bg-brand-green transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-3 flex items-baseline justify-between border-t border-gray-100 pt-2 text-xs text-gray-500">
        <span>實付金額</span>
        <span className="text-base font-bold text-brand-primary">{formatTWD(period.final_price)}</span>
      </div>
    </button>
  );
}
