import React from 'react';
import { formatTWD } from '../utils/format';

export default function CoachCard({ coach, basePrice, onSelect }) {
  const adjusted = Math.round((basePrice || 0) * (coach.multiplier || 1));
  const initial = (coach.name || '？').slice(0, 1);
  const coefficientPct = Math.round((coach.multiplier ?? 1) * 100);
  const isAdjustedCoefficient = coefficientPct !== 100;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(coach)}
      className={`group block w-full rounded-2xl border-2 p-4 text-left transition active:scale-[0.99] ${
        isAdjustedCoefficient
          ? 'border-brand-amber bg-gradient-to-br from-amber-50 to-white shadow-sm shadow-amber-100'
          : coach.is_senior
          ? 'border-brand-gold bg-gradient-to-br from-amber-50 to-white'
          : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-xl font-bold ${
            coach.is_senior ? 'bg-brand-gold text-white' : 'bg-brand-primary text-white'
          }`}
        >
          {initial}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-gray-900">{coach.name}</h3>
            {coach.is_senior && (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-gold px-2 py-0.5 text-xs font-medium text-white">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
                </svg>
                資深教練
              </span>
            )}
          </div>

          {coach.tags?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {coach.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-md bg-brand-teal/10 px-1.5 py-0.5 text-[11px] font-medium text-brand-teal"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {coach.bio && (
            <p className="mt-2 line-clamp-2 text-xs text-gray-600">{coach.bio}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between border-t border-gray-100 pt-3">
        <div className="text-xs text-gray-500">
          修課係數{' '}
          <span className={`font-bold ${isAdjustedCoefficient ? 'text-brand-amber' : 'text-brand-primary'}`}>
            {coefficientPct}%
          </span>
          <span className="ml-2">/ 6 堂</span>
        </div>
        <div className="text-right">
          {isAdjustedCoefficient && (
            <div className="text-[11px] text-gray-400 line-through">{formatTWD(basePrice)}</div>
          )}
          <div className="text-lg font-bold text-brand-primary">{formatTWD(adjusted)}</div>
        </div>
      </div>
    </button>
  );
}
