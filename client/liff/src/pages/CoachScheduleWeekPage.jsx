import React, { useEffect, useMemo, useState } from 'react';
import { slotsApi } from '../api/slots';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import SlotChip from '../components/coach/SlotChip';
import AddSlotModal from '../components/coach/AddSlotModal';
import BatchAddSlotModal from '../components/coach/BatchAddSlotModal';
import SlotActionSheet from '../components/coach/SlotActionSheet';

const WEEKDAY_TC = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function startOfWeek(d) { const x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - x.getDay()); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth(), 1); x.setHours(0,0,0,0); return x; }
function startOfNextMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }

function sameYMD(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 px-3 py-1 rounded-full text-xs border transition ${
        active
          ? 'bg-brand-primary text-white border-brand-primary'
          : 'bg-white text-brand-primary border-brand-primary/30 hover:bg-brand-primary/5'
      }`}
    >
      {children}
    </button>
  );
}

export default function CoachScheduleWeekPage() {
  const { coach } = useAuth();
  const toast = useToast();
  const [view, setView] = useState('week'); // 'week' | 'month'
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [venueFilter, setVenueFilter] = useState('all'); // 'all' | venue_id
  const [slots, setSlots] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [activeSlot, setActiveSlot] = useState(null);
  const [reload, setReload] = useState(0);

  const venueIds = coach?.venue_ids || [];

  const range = useMemo(() => {
    if (view === 'week') return { from: anchor, to: addDays(anchor, 7) };
    const from = startOfMonth(anchor);
    return { from, to: startOfNextMonth(from) };
  }, [view, anchor]);

  useEffect(() => {
    if (!coach?.id) return;
    let alive = true;
    setSlots(null);
    slotsApi.listByCoach(coach.id, { from: range.from.toISOString(), to: range.to.toISOString() })
      .then((d) => alive && setSlots(d || []))
      .catch(() => { if (alive) { setSlots([]); toast.error('排課資料載入失敗'); } });
    return () => { alive = false; };
  }, [coach?.id, range.from, range.to, reload, toast]);

  const filteredSlots = useMemo(
    () => (slots || []).filter((s) => venueFilter === 'all' || s.venue_id === venueFilter),
    [slots, venueFilter]
  );

  const days = useMemo(() => {
    const result = [];
    for (let d = new Date(range.from); d < range.to; d = addDays(d, 1)) {
      result.push(new Date(d));
    }
    return result;
  }, [range.from, range.to]);

  function shift(direction) {
    const days = view === 'week' ? 7 : (direction > 0 ? 31 : -31);
    setAnchor((prev) => view === 'week'
      ? addDays(prev, 7 * direction)
      : new Date(prev.getFullYear(), prev.getMonth() + direction, 1));
  }
  function jumpToday() {
    setAnchor(view === 'week' ? startOfWeek(new Date()) : startOfMonth(new Date()));
  }
  function refresh() { setReload((x) => x + 1); }

  if (!coach) return null;

  const headerLabel = view === 'week'
    ? `${range.from.getMonth() + 1}/${range.from.getDate()} – ${addDays(range.from, 6).getMonth() + 1}/${addDays(range.from, 6).getDate()}`
    : `${anchor.getFullYear()}年 ${anchor.getMonth() + 1} 月`;

  return (
    <div className="pb-4">
      <header className="sticky top-0 z-10 border-b border-gray-100 bg-white px-4 py-2.5">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-bold text-brand-primary">排課總表</h1>
          <div className="flex rounded-full bg-gray-100 p-0.5 text-xs">
            <button onClick={() => setView('week')}
              className={`rounded-full px-3 py-1 ${view === 'week' ? 'bg-white text-brand-primary shadow-sm' : 'text-gray-500'}`}>週</button>
            <button onClick={() => setView('month')}
              className={`rounded-full px-3 py-1 ${view === 'month' ? 'bg-white text-brand-primary shadow-sm' : 'text-gray-500'}`}>月</button>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between text-sm">
          <button onClick={() => shift(-1)} className="rounded-lg px-2 py-1 text-brand-primary active:bg-gray-100">‹</button>
          <button onClick={jumpToday} className="rounded-lg px-3 py-1 text-xs font-medium text-brand-teal">{headerLabel}</button>
          <button onClick={() => shift(1)} className="rounded-lg px-2 py-1 text-brand-primary active:bg-gray-100">›</button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <FilterChip active={venueFilter === 'all'} onClick={() => setVenueFilter('all')}>全部</FilterChip>
          {venueIds.map((v) => (
            <FilterChip key={v} active={venueFilter === v} onClick={() => setVenueFilter(v)}>{v} 館</FilterChip>
          ))}
        </div>
      </header>

      <div className="px-4 pt-3">
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button onClick={() => setShowAdd(true)}
            className="rounded-lg bg-brand-primary py-2 text-sm font-bold text-white active:bg-brand-teal">＋ 新增槽位</button>
          <button onClick={() => setShowBatch(true)}
            className="rounded-lg border border-brand-primary/30 py-2 text-sm font-bold text-brand-primary active:bg-brand-primary/5">批量新增</button>
        </div>

        {slots === null && <LoadingSpinner label="載入排課中…" />}
        {slots !== null && view === 'week' && (
          <div className="space-y-3">
            {days.map((d) => {
              const daySlots = filteredSlots.filter((s) => sameYMD(new Date(s.start_at), d));
              return <DaySection key={d.toISOString()} date={d} slots={daySlots} onClickSlot={(slot) => setActiveSlot(slot)} />;
            })}
            {filteredSlots.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
                此範圍尚無槽位。
              </div>
            )}
          </div>
        )}
        {slots !== null && view === 'month' && (
          <MonthGrid
            anchor={anchor}
            slots={filteredSlots}
            onPickDate={(d) => { setView('week'); setAnchor(startOfWeek(d)); }}
          />
        )}
      </div>

      {showAdd && (
        <AddSlotModal coachId={coach.id} venueIds={venueIds}
          onClose={() => setShowAdd(false)}
          onCreated={() => { toast.success('已新增槽位'); refresh(); }}
          onError={(msg) => toast.error(msg)} />
      )}
      {showBatch && (
        <BatchAddSlotModal coachId={coach.id} venueIds={venueIds}
          onClose={() => setShowBatch(false)}
          onDone={(r) => { toast.success(`已建立 ${r.created} 筆，跳過 ${r.skipped} 筆`); refresh(); }}
          onError={(msg) => toast.error(msg)} />
      )}
      {activeSlot && (
        <SlotActionSheet slot={activeSlot}
          onClose={() => setActiveSlot(null)}
          onMutated={() => { toast.success('已更新'); refresh(); }}
          onError={(msg) => toast.error(msg)} />
      )}
    </div>
  );
}

/**
 * 月視圖：色塊概覽（規格 F-C02 月視圖）
 * - 7 欄 × N 列日曆網格；非本月以淡色顯示
 * - 每格底部有最多 3 條色條：available(綠) / booked(藍) / blocked(灰)；超過顯 +n
 * - 點任一日 → 切回週視圖並 anchor 到該週週日
 */
function MonthGrid({ anchor, slots, onPickDate }) {
  const monthStart = startOfMonth(anchor);
  const monthEnd = startOfNextMonth(monthStart);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = (() => { const e = startOfWeek(monthEnd); return monthEnd > e ? addDays(e, 7) : e; })();

  const cells = [];
  for (let d = new Date(gridStart); d < gridEnd; d = addDays(d, 1)) cells.push(new Date(d));
  const today = new Date();

  function bucketsFor(d) {
    const ds = slots.filter((s) => sameYMD(new Date(s.start_at), d));
    const counts = { available: 0, booked: 0, blocked: 0 };
    for (const s of ds) {
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

function DaySection({ date, slots, onClickSlot }) {
  const isToday = sameYMD(date, new Date());
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <h3 className={`text-xs font-bold ${isToday ? 'text-brand-teal' : 'text-brand-primary'}`}>
          {date.getMonth() + 1}/{date.getDate()}（{WEEKDAY_TC[date.getDay()]}）{isToday && ' · 今天'}
        </h3>
        <span className="text-[10px] text-gray-400">{slots.length} 筆</span>
      </div>
      {slots.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white p-3 text-center text-xs text-gray-400">
          無槽位
        </div>
      ) : (
        <div className="space-y-1.5">
          {slots.map((s) => <SlotChip key={s.id} slot={s} onClick={onClickSlot} />)}
        </div>
      )}
    </div>
  );
}
