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
    // auto 時段 venue_id 為 NULL＝跨場館共用，任何場館篩選下都該留著；
    // 否則教練一按場館 chip，自己那些自動時段就整批消失，看起來像沒產生。
    () => (slots || []).filter(
      (s) => venueFilter.size === 0 || s.venue_id == null || venueFilter.has(s.venue_id)
    ),
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
        {/* 模組 1 的模型是反過來的：可預約時段依場館營業時間自動開放，教練做的是
            「關掉不想開的時段」，不是「一格一格加上去」。頁面第一眼如果還是
            「＋ 新增槽位」，教練會以為沒加就沒有時段，整個反轉等於沒發生。
            手動新增仍然保留——營業時間以外的臨時加開還是需要它——但降為次要。 */}
        <div className="mb-3 rounded-xl border border-teal-200 bg-teal-50/60 px-3 py-2.5">
          <p className="text-[13px] font-bold text-teal-900">可預約時段會依場館營業時間自動開放</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-teal-800/80">
            不用逐格新增。點下面任一時段可以「關閉」它，關掉的時段之後的週期會沿用，
            隨時可以再打開。
          </p>
        </div>
        <details className="mb-3">
          <summary className="cursor-pointer list-none rounded-lg border border-gray-300 py-2 text-center text-sm font-medium text-gray-600 active:bg-gray-50">
            需要臨時加開營業時間以外的時段？
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button onClick={() => setShowAdd(true)}
              className="rounded-lg border border-brand-primary/30 py-2 text-sm font-bold text-brand-primary active:bg-brand-primary/5">＋ 新增槽位</button>
            <button onClick={() => setShowBatch(true)}
              className="rounded-lg border border-brand-primary/30 py-2 text-sm font-bold text-brand-primary active:bg-brand-primary/5">批量新增</button>
          </div>
        </details>

        {slots === null && <LoadingSpinner label="載入排課中…" />}
        {slots !== null && view === 'week' && (
          <div className="space-y-3">
            {days.map((d) => {
              const daySlots = filteredSlots.filter((s) => sameYMD(taipeiCalendarDate(s.start_at), d));
              return <DaySection key={d.toISOString()} date={d} slots={daySlots} onClickSlot={(slot) => setActiveSlot(slot)} />;
            })}
            {/* 空狀態要說得出「為什麼空」。舊文案「此範圍尚無槽位」在新模型下
                會讓教練以為是自己沒排——實際上多半是場館營業時間還沒設定，
                那是系統管理員／場館主管的事，教練自己怎麼點都不會有時段。 */}
            {filteredSlots.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
                <p className="font-medium text-gray-600">這週沒有可預約時段</p>
                <p className="mt-1 text-[12px] leading-relaxed">
                  時段依場館營業時間自動開放。如果整週都是空的，通常是所屬場館尚未設定營業時間，
                  請聯繫櫃檯或場館主管確認；你不需要自己逐格新增。
                </p>
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
