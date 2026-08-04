import React from 'react';
import { summarizeWeeklyHours, formatClosedDate } from '../../utils/venueHoursSummary';

/**
 * 排課總表上方的營業時間備註。
 *
 * 時段是依場館營業時間自動長出來的，教練得看得到依據，否則整週空白時
 * 無從判斷是自己關光了、還是場館根本沒設營業時間（那是管理員的事）。
 *
 * 刻意做得很扁：一館一行、每週時間壓成「週一~週五 05:30–22:00」這種區間，
 * 七天各一行會把排課總表擠爆。休館日只列出目前檢視範圍內的。
 */
export default function VenueHoursNote({ venues, rangeLabel }) {
  if (!venues) return null;

  return (
    <div className="mb-3 rounded-xl border border-teal-200 bg-teal-50/60 px-3 py-2.5">
      <p className="text-[13px] font-bold text-teal-900">
        場館營業時間內預設全部開放預約
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-teal-800/80">
        不用逐格新增。請關閉你不能上課的時段——關掉的之後週期會沿用，隨時可以再打開。
      </p>

      {venues.length === 0 && (
        <p className="mt-2 text-[11px] text-teal-800/70">尚未查到你的所屬場館。</p>
      )}

      <div className="mt-2 space-y-1.5">
        {venues.map((v) => {
          const s = summarizeWeeklyHours(v.hours);
          return (
            <div key={v.venue_id} className="rounded-lg bg-white/70 px-2.5 py-1.5">
              <div className="text-[11px] font-bold text-teal-900">{v.venue_name || v.venue_id}</div>
              {!s.hasAny ? (
                <div className="mt-0.5 text-[11px] text-brand-error">
                  尚未設定營業時間 → 不會產生任何可預約時段，請洽櫃檯或場館主管。
                </div>
              ) : (
                <>
                  {s.lines.map((l) => (
                    <div key={l.label} className="mt-0.5 flex gap-2 text-[11px] text-gray-700">
                      <span className="w-[68px] shrink-0 text-gray-500">{l.label}</span>
                      <span className="tabular-nums">{l.time}</span>
                    </div>
                  ))}
                  {s.closedLabel && (
                    <div className="mt-0.5 text-[11px] text-gray-400">{s.closedLabel}</div>
                  )}
                </>
              )}
              {v.closed_dates?.length > 0 && (
                <div className="mt-1 text-[11px] text-amber-700">
                  {rangeLabel ? `${rangeLabel} 休館：` : '特殊休館：'}
                  {v.closed_dates.map(formatClosedDate).join('、')}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}