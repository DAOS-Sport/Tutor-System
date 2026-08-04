import React, { useEffect, useMemo, useState } from 'react';
import { coachesApi } from '../api/coaches';
import { slotsApi } from '../api/slots';
import { venuesApi } from '../api/venues';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import SlotChip from '../components/coach/SlotChip';
import AddSlotModal from '../components/coach/AddSlotModal';
import BatchAddSlotModal from '../components/coach/BatchAddSlotModal';
import BatchResultModal from '../components/coach/BatchResultModal';
import SlotActionSheet from '../components/coach/SlotActionSheet';
import MonthGrid from '../components/coach/MonthGrid';
import { cleanVenueList } from '../utils/venues';
import { formatPlainDate, taipeiCalendarDate } from '../utils/format';

const WEEKDAY_TC = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function startOfWeek(d) { const x = taipeiCalendarDate(d); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return x; }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function startOfMonth(d) { const x = taipeiCalendarDate(d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1)); }
function startOfNextMonth(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); }

function sameYMD(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function taipeiBoundaryIso(calendarDate) {
  return new Date(`${formatPlainDate(calendarDate)}T00:00:00+08:00`).toISOString();
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
  const [venueFilter, setVenueFilter] = useState(() => new Set()); // 空集合 = 全部
  const [slots, setSlots] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [activeSlot, setActiveSlot] = useState(null);
  const [batchResult, setBatchResult] = useState(null);
  const [reload, setReload] = useState(0);
  const [venueNameMap, setVenueNameMap] = useState({}); // { 場館代碼: 場館名稱 }
  const [freshVenueIds, setFreshVenueIds] = useState(null);

  function toggleVenue(v) {
    setVenueFilter((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v); else next.add(v);
      return next;
    });
  }

  const venueIds = useMemo(() => {
    const source = freshVenueIds !== null ? freshVenueIds : (coach?.venue_ids || coach?.venues || []);
    return cleanVenueList(source);
  }, [freshVenueIds, coach?.venue_ids, coach?.venues]);
  const venueLabel = (v) => venueNameMap[v] || `${v} 館`;

  useEffect(() => {
    if (!coach?.id) {
      setFreshVenueIds(null);
      return undefined;
    }
    let alive = true;
    setFreshVenueIds(null);
    coachesApi.detail(coach.id)
      .then((c) => {
        if (alive) setFreshVenueIds(cleanVenueList(c?.venue_ids || c?.venues || []));
      })
      .catch(() => {
        if (alive) setFreshVenueIds(null);
      });
    return () => { alive = false; };
  }, [coach?.id]);

  useEffect(() => {
    let alive = true;
    venuesApi.list()
      .then((list) => {
        if (!alive) return;
        const map = {};
        (list || []).forEach((vn) => { if (vn?.id) map[vn.id] = vn.name || vn.id; });
        setVenueNameMap(map);
      })
      .catch(() => {}); // 取不到名稱時 fallback 顯示「{代碼} 館」
    return () => { alive = false; };
  }, []);

  const range = useMemo(() => {
    if (view === 'week') return { from: anchor, to: addDays(anchor, 7) };
    const from = startOfMonth(anchor);
    return { from, to: startOfNextMonth(from) };
  }, [view, anchor]);

  useEffect(() => {
    if (!coach?.id) return;
    let alive = true;
    setSlots(null);
    slotsApi.listByCoach(coach.id, { from: taipeiBoundaryIso(range.from), to: taipeiBoundaryIso(range.to) })
      .then((d) => alive && setSlots(d || []))
      .catch(() => { if (alive) { setSlots([]); toast.error('排課資料載入失敗'); } });
    return () => { alive = false; };
  }, [coach?.id, range.from, range.to, reload, toast]);

  const filteredSlots = useMemo(
    () => (slots || []).filter((s) => venueFilter.size === 0 || venueFilter.has(s.venue_id)),
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
      : new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + direction, 1)));
  }
  function jumpToday() {
    setAnchor(view === 'week' ? startOfWeek(new Date()) : startOfMonth(new Date()));
  }
  function refresh() { setReload((x) => x + 1); }

  if (!coach) return null;

  const headerLabel = view === 'week'
    ? `${range.from.getUTCMonth() + 1}/${range.from.getUTCDate()} – ${addDays(range.from, 6).getUTCMonth() + 1}/${addDays(range.from, 6).getUTCDate()}`
    : `${anchor.getUTCFullYear()}年 ${anchor.getUTCMonth() + 1} 月`;

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
          <FilterChip active={venueFilter.size === 0} onClick={() => setVenueFilter(new Set())}>全部</FilterChip>
          {venueIds.map((v) => (
            <FilterChip key={v} active={venueFilter.has(v)} onClick={() => toggleVenue(v)}>{venueLabel(v)}</FilterChip>
          ))}
        </div>
      </header>

      <div className="px-4 pt-3">
        {/* 目前所有課期都是自助簽到制：家長不必先預約，來上課就自己簽到。
            排課時段只有在教練「主動排出來」之後才會變成預約制。教練不知道這件事
            的話，會以為沒排時段＝學生約不到課，其實學生照樣可以簽到。 */}
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="text-[13px] font-bold text-amber-900">目前是自助簽到制</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-amber-800/90">
            若有需求則可增加時段變成授課預約制；否則家長可於家長畫面任意進行簽到，
            再請提醒家長。
          </p>
        </div>

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
              const daySlots = filteredSlots.filter((s) => sameYMD(taipeiCalendarDate(s.start_at), d));
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
        <AddSlotModal coachId={coach.id} venueIds={venueIds} venueNameMap={venueNameMap}
          onClose={() => setShowAdd(false)}
          onCreated={() => { toast.success('已新增槽位'); refresh(); }}
          onError={(msg) => toast.error(msg)} />
      )}
      {showBatch && (
        <BatchAddSlotModal coachId={coach.id} venueIds={venueIds} venueNameMap={venueNameMap}
          onClose={() => setShowBatch(false)}
          onDone={(r) => { setBatchResult(r); refresh(); }}
          onError={(msg) => toast.error(msg)} />
      )}
      {batchResult && (
        <BatchResultModal result={batchResult} onClose={() => setBatchResult(null)} />
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

function DaySection({ date, slots, onClickSlot }) {
  const isToday = sameYMD(date, taipeiCalendarDate());
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <h3 className={`text-xs font-bold ${isToday ? 'text-brand-teal' : 'text-brand-primary'}`}>
          {date.getUTCMonth() + 1}/{date.getUTCDate()}（{WEEKDAY_TC[date.getUTCDay()]}）{isToday && ' · 今天'}
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
