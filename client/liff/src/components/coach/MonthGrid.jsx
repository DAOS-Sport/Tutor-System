import React from 'react';

const WEEKDAY_TC = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function startOfWeek(d) { const x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - x.getDay()); return x; }
function startOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth(), 1); x.setHours(0,0,0,0); return x; }
function startOfNextMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameYMD(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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
  const today = new Date();

  function bucketsFor(d) {
    const counts = { available: 0, booked: 0, blocked: 0 };
    for (const s of slots) {
      if (!sameYMD(new Date(s.start_at), d)) continue;
      if (s.status === 'available') counts.available++;
      else if (s.status === 'booked' || s.status === 'pending_group_confirm') counts.booked++;
      else if (s.status === 'blocked') counts.blocked++;
    }
    return counts;
  }

  return (
    <div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-gray-400">
        {WEEKDAY_TC.map((w) => <div key={w} className="py-1">{w.slice(1)}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d) => {
          const inMonth = d >= monthStart && d < monthEnd;
          const isToday = sameYMD(d, today);
          const c = bucketsFor(d);
          const total = c.available + c.booked + c.blocked;
          return (
            <button
              key={d.toISOString()}
              onClick={() => onPickDate(d)}
              className={`flex h-14 flex-col rounded-lg border p-1 text-left text-[11px] transition active:scale-95 ${
                inMonth ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100 opacity-60'
              } ${isToday ? 'ring-2 ring-brand-teal' : ''}`}
            >
              <span className={`text-[11px] font-bold ${isToday ? 'text-brand-teal' : inMonth ? 'text-brand-primary' : 'text-gray-400'}`}>
                {d.getDate()}
              </span>
              {total > 0 && (
                <div className="mt-auto flex gap-0.5">
                  {c.available > 0 && <span className="h-1 flex-1 rounded bg-brand-green" title={`可預約 ${c.available}`} />}
                  {c.booked    > 0 && <span className="h-1 flex-1 rounded bg-brand-teal"  title={`已預約 ${c.booked}`} />}
                  {c.blocked   > 0 && <span className="h-1 flex-1 rounded bg-gray-400"    title={`封鎖 ${c.blocked}`} />}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-center gap-3 text-[10px] text-gray-500">
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-brand-green" />可預約</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-brand-teal" />已預約</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-gray-400" />封鎖</span>
      </div>
    </div>
  );
}
