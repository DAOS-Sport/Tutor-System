import React from 'react';
import { taipeiCalendarDate } from '../../utils/format';

const WEEKDAY_TC = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function startOfWeek(d) { const x = taipeiCalendarDate(d); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return x; }
function startOfMonth(d) { const x = taipeiCalendarDate(d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1)); }
function startOfNextMonth(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function sameYMD(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

/**
 * 月視圖：色塊概覽（規格 F-C02 月視圖）
 * - 7 欄 × N 列日曆網格；非本月以淡色顯示
 * - 每格底部最多 3 條色條：available(綠) / booked(青) / blocked(灰)
 * - 點任一日 → onPickDate(date) 由 parent 切回週視圖
 */
export default function MonthGrid({ anchor, slots, onPickDate }) {
  const monthStart = startOfMonth(anchor);
  const monthEnd = startOfNextMonth(monthStart);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = (() => { const e = startOfWeek(monthEnd); return monthEnd > e ? addDays(e, 7) : e; })();

  const cells = [];
  for (let d = new Date(gridStart); d < gridEnd; d = addDays(d, 1)) cells.push(new Date(d));
  const today = taipeiCalendarDate();

  function bucketsFor(d) {
    const counts = { available: 0, booked: 0, blocked: 0 };
    for (const s of slots) {
      if (!sameYMD(taipeiCalendarDate(s.start_at), d)) continue;
      if (s.status === 'available') counts.available++;
      else if (s.status === 'booked' || s.status === 'pending_group_confirm') counts.booked++;
      else if (s.status === 'blocked') counts.blocked++;
    }
    return counts;
  }

  return (
    <div>
      {/* 與共用 DateTimePicker 同一套語彙：無框線、週末用品牌青、今天用細環、
          數字在上小字在下。這裡的小字是可預約堂數 —— 教練掃月曆就是在找那個。 */}
      <div className="grid grid-cols-7 text-center text-[11px] font-bold">
        {WEEKDAY_TC.map((w, i) => (
          <div key={w} className={`py-1.5 ${i === 0 || i === 6 ? 'text-brand-teal' : 'text-gray-400'}`}>{w.slice(1)}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1">
        {cells.map((d, i) => {
          const inMonth = d >= monthStart && d < monthEnd;
          const isToday = sameYMD(d, today);
          const c = bucketsFor(d);
          const dow = i % 7;
          // 一格只給一個數字。三種狀態互斥呈現：有空堂就報空堂數（教練要找的），
          // 沒空堂但有預約就是「滿」，只剩封鎖就是「休」。
          const sub = c.available > 0 ? String(c.available)
            : c.booked > 0 ? '滿'
              : c.blocked > 0 ? '休' : '';
          const subTone = c.available > 0 ? 'text-brand-green'
            : c.booked > 0 ? 'text-brand-teal' : 'text-gray-400';
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onPickDate(d)}
              className={`mx-auto flex h-12 w-11 flex-col items-center justify-center gap-0.5 rounded-lg transition active:scale-95 ${
                isToday ? 'bg-brand-primary text-white'
                  : c.available > 0 ? 'bg-brand-green/10 hover:bg-brand-green/20'
                    : 'hover:bg-gray-100'
              }`}
            >
              <span className={`text-[13px] tabular-nums ${
                isToday ? 'font-bold text-white'
                  : !inMonth ? 'font-normal text-gray-300'
                    : dow === 0 || dow === 6 ? 'font-bold text-brand-teal' : 'font-medium text-gray-700'
              }`}>
                {d.getUTCDate()}
              </span>
              <span className={`text-[10px] leading-none tabular-nums ${isToday ? 'text-white/80' : subTone}`}>
                {sub || '\u00a0'}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-center gap-3 text-[10px] text-gray-500">
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-brand-green" />數字＝可預約</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-brand-teal" />滿＝已約完</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-gray-400" />休＝已封鎖</span>
      </div>
    </div>
  );
}
