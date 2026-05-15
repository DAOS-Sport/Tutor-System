import React, { useMemo } from 'react';
import { courseTypeLabel } from '../utils/format';

/**
 * 週課表視角
 *  - 7 列（週日為第一列）× 時段欄
 *  - 時段範圍依 sessions 動態抓 min/max 小時（fallback 9-21）
 *  - 同格多筆垂直堆疊
 *
 * Props:
 *   sessions: [{ id, date, start, end, venue_id, coach, students[], course_type, checkin_status }]
 *   from:     'YYYY-MM-DD' 區間第一天（=週日 or 月初）
 *   to:       'YYYY-MM-DD' 區間最後一天
 *   venues:   [{ id, name }]
 *   onSelect: (session) => void
 */

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const TONE = {
  1: 'border-brand-teal/40 bg-brand-teal/10 text-brand-teal',
  2: 'border-brand-amber/40 bg-brand-amber/10 text-brand-amber',
  3: 'border-brand-green/40 bg-brand-green/10 text-brand-green',
};

// Task #55：以「分鐘」為單位處理；half-hour grid 用 30 分鐘 slot
function parseMinutes(t) {
  const [hStr, mStr] = String(t || '00:00').split(':');
  const h = Number(hStr); const m = Number(mStr) || 0;
  return Number.isFinite(h) ? h * 60 + m : 0;
}
function fmtSlot(min) {
  const h = Math.floor(min / 60); const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
// 把 raw start (HH:MM) 對齊到所屬 30 分鐘 slot
function slotOf(t) {
  const m = parseMinutes(t);
  return m - (m % 30);
}

function dateAdd(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function WeekGridView({ sessions, from, to, venues, onSelect }) {
  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;

  const { slots, weeks } = useMemo(() => {
    let minM = 9 * 60; let maxM = 21 * 60;
    sessions.forEach((s) => {
      const sm = slotOf(s.start);
      const em = parseMinutes(s.end) || (sm + 60);
      if (sm < minM) minM = sm;
      if (em > maxM) maxM = em;
    });
    // 對齊半小時、收斂到一日內
    minM = Math.max(0, Math.min(minM, 9 * 60));
    minM = minM - (minM % 30);
    maxM = Math.min(24 * 60, Math.max(maxM, 21 * 60));
    if (maxM % 30) maxM = maxM + (30 - (maxM % 30));
    const sl = [];
    for (let i = minM; i < maxM; i += 30) sl.push(i);

    const ws = [];
    let cursor = from;
    while (cursor <= to) {
      const end = dateAdd(cursor, 6);
      ws.push({ start: cursor, end: end > to ? to : end });
      cursor = dateAdd(cursor, 7);
    }
    return { slots: sl, weeks: ws };
  }, [sessions, from, to]);

  // index: dateISO -> slotMin -> sessions
  const byCell = useMemo(() => {
    const m = new Map();
    sessions.forEach((s) => {
      const sm = slotOf(s.start);
      const key = `${s.date}|${sm}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(s);
    });
    return m;
  }, [sessions]);

  if (!sessions.length) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center text-sm text-gray-500">
        所選範圍 / 場館內沒有課程
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {weeks.map((w) => {
        const dates = [];
        for (let i = 0; i < 7; i += 1) {
          const d = dateAdd(w.start, i);
          if (d > to) break;
          dates.push(d);
        }
        return (
          <div key={w.start} className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <div className="min-w-[720px]">
              <div className="grid border-b border-gray-200 bg-gray-50 text-xs"
                   style={{ gridTemplateColumns: `64px repeat(${dates.length}, minmax(96px, 1fr))` }}>
                <div className="px-2 py-2 text-gray-400">時段</div>
                {dates.map((d) => {
                  const dt = new Date(d + 'T00:00:00');
                  return (
                    <div key={d} className="border-l border-gray-200 px-2 py-2 text-center">
                      <div className="font-semibold text-gray-700">週{DOW[dt.getDay()]}</div>
                      <div className="text-[11px] text-gray-400">{d.slice(5)}</div>
                    </div>
                  );
                })}
              </div>
              {slots.map((sm) => {
                const isHourTop = sm % 60 === 0;
                return (
                <div key={sm} className={`grid ${isHourTop ? 'border-b border-gray-200' : 'border-b border-dashed border-gray-100'} last:border-b-0`}
                     style={{ gridTemplateColumns: `64px repeat(${dates.length}, minmax(96px, 1fr))` }}>
                  <div className={`border-r border-gray-100 bg-gray-50 px-2 py-1 text-xs font-mono ${isHourTop ? 'text-gray-600 font-semibold' : 'text-gray-400'}`}>
                    {fmtSlot(sm)}
                  </div>
                  {dates.map((d) => {
                    const items = byCell.get(`${d}|${sm}`) || [];
                    return (
                      <div key={d} className={`min-h-[40px] border-l border-gray-100 p-1 space-y-1 ${items.length ? '' : 'bg-gray-50/40'}`}>
                        {items.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => onSelect && onSelect(s)}
                            className={`w-full rounded border px-1.5 py-1 text-left text-[11px] leading-tight ${TONE[s.course_type] || 'border-gray-300 bg-gray-50 text-gray-700'}`}
                            title={`${s.start}-${s.end} ${venueName(s.venue_id)} ${s.coach}`}
                          >
                            <div className="font-semibold">{s.coach}・{courseTypeLabel(s.course_type)}</div>
                            <div className="truncate text-gray-600">{(s.students || []).join('、')}</div>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
