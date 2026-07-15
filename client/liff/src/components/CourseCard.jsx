import React from 'react';
import { formatTWD, formatTWDate, paymentStatusColor, paymentStatusLabel, courseTypeLabel } from '../utils/format';

/**
 * 兩種模式：
 *  - variant="catalog"：首頁三組別卡片（display only + CTA）
 *  - variant="period"：「我的課程」用，顯示已開通/待對帳的課程期
 */
export default function CourseCard({ variant = 'period', period, type, onClick, ctaLabel = '立即報名', actions = [] }) {
  if (variant === 'catalog') {
    return (
      <button
        type="button"
        onClick={onClick}
        className="block w-full overflow-hidden rounded-2xl border border-gray-200 bg-white text-left shadow-sm active:scale-[0.99]"
      >
        {type.imageUrl && (
          <img src={type.imageUrl} alt={type.title || ''} className="h-32 w-full object-cover" />
        )}
        <div className="bg-brand-primary px-4 py-3 text-white">
          <div className="text-base font-bold">{type.title}</div>
          {type.subtitle && <div className="text-xs opacity-90">{type.subtitle}</div>}
        </div>
        <div className="p-4">
          {type.description && <p className="mb-3 whitespace-pre-line text-sm text-gray-600">{type.description}</p>}
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-xs text-gray-500">每期 6 堂</span>
            <span className="text-lg font-bold text-brand-primary">{formatTWD(type.basePrice)}/人</span>
          </div>
          <div className="w-full rounded-lg bg-brand-teal py-2.5 text-center text-sm font-bold text-white">
            {ctaLabel}
          </div>
        </div>
      </button>
    );
  }

  // variant === 'period'
  const pct = period.total_sessions
    ? Math.min(100, Math.round((period.used_sessions / period.total_sessions) * 100))
    : 0;
  const hasSessionProgress = Number(period.total_sessions) > 0;
  const studentNames = (period.students || []).map((s) => (typeof s === 'string' ? s : s.name)).filter(Boolean).join('、');
  // 摘要行：教練_品相-係數%（剩 未上課/總 N）。剩餘＝總−已出席；total===0（尚未開通）時略過（剩/總）。
  const sessTotal = Number(period.total_sessions) || 0;
  const sessRemaining = Math.max(0, sessTotal - (Number(period.used_sessions) || 0));
  const multiplierPct = Math.round((Number(period.pricing_multiplier) || 1) * 100);
  const summaryLine = period.is_checkout_aggregate
    ? `${period.coach?.name || '教練'}_${courseTypeLabel(period.course_type)}（共 ${period.period_count || period.sub_order_count || 1} 期）`
    : `${period.coach?.name || '教練'}_${courseTypeLabel(period.course_type)}-${multiplierPct}%`
      + (sessTotal > 0 ? `（剩 ${sessRemaining}/總 ${sessTotal}）` : '');
  // 已結束（completed）以 lifecycle 判定並顯示灰色「已結束」徽章；
  // 其餘維持原本以 payment_status 顯示狀態（待對帳／進行中…）。
  const badgeStatus = period.lifecycle === 'completed' ? 'completed' : period.payment_status;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm">
      <button
        type="button"
        onClick={onClick}
        className={`block w-full text-left ${onClick ? 'active:opacity-80' : 'cursor-default'}`}
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
          <h3 className="mt-1 truncate text-base font-bold text-brand-primary">{summaryLine}</h3>
          <p className="mt-0.5 truncate text-xs text-gray-500">
            {period.venue?.name ? `${period.venue.name} · ` : ''}學員：{studentNames || '—'}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-gray-400">
            {period.is_checkout_aggregate ? '付款單編號' : '訂單編號'}：{period.id || '—'}
          </p>
          {period.group_order_id && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-gray-400">團購單號：{period.group_order_id}</p>
          )}
          {period.partner_checkin_label && (
            <p className="mt-1 text-xs font-medium text-brand-teal">
              ✓ {period.partner_checkin_label}已代為簽到
            </p>
          )}
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${paymentStatusColor(badgeStatus)}`}>
          {paymentStatusLabel(badgeStatus)}
        </span>
        </div>

        <div className="mt-2 mb-1 flex items-center justify-between text-xs text-gray-600">
        {period.is_checkout_aggregate ? (
          <>
            <span>
              付款單 <span className="font-bold text-brand-primary">共 {period.period_count || period.sub_order_count || 1} 期</span>
            </span>
            <span>待完成付款</span>
          </>
        ) : (
          <>
            <span>
              堂數進度{' '}
              <span className="font-bold text-brand-primary">
                {hasSessionProgress ? `${period.used_sessions}/${period.total_sessions}` : '尚未開通'}
              </span>
            </span>
            <span>到期 {formatTWDate(period.expires_at)}</span>
          </>
        )}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className="h-full rounded-full bg-brand-green transition-all"
          style={{ width: `${pct}%` }}
        />
        </div>

        <div className="mt-3 flex items-baseline justify-between border-t border-gray-100 pt-2 text-xs text-gray-500">
        <span>{period.is_checkout_aggregate ? '總應繳金額' : '實付金額'}</span>
        <span className="text-base font-bold text-brand-primary">{formatTWD(period.final_price)}</span>
        </div>
      </button>

      {actions.length > 0 && (
        <div className={`mt-3 grid gap-2 ${
          actions.length === 1 ? 'grid-cols-1' : actions.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'
        }`}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              className={`rounded-lg px-2 py-2 text-sm font-bold disabled:opacity-50 ${
                action.tone === 'accent'
                  ? 'bg-brand-amber text-black active:opacity-90'
                  : action.primary
                    ? 'bg-brand-primary text-white active:bg-brand-teal'
                    : 'border border-brand-teal text-brand-teal active:bg-brand-teal/10'
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
