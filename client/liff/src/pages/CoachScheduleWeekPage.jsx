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
  // 批量編輯：模組 1 的模型是「預設全開，教練自己排掉不能上的」，
  // 所以主要動作是一次關掉一整批，不是一格一格加。
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);

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

  // ── 批量編輯 ─────────────────────────────────────────────────────────
  // 已預約的槽位不可被選：關掉或刪掉它等於把家長已經約好的課弄不見，
  // 那必須走家長端取消或櫃檯。這裡直接不給選，而不是選了才報錯。
  const selectableSlots = filteredSlots.filter((s) => s.status !== 'booked');
  const selectedSlots = selectableSlots.filter((s) => selected.has(s.id));
  const selectedAvailable = selectedSlots.filter((s) => s.status === 'available');
  const selectedBlocked = selectedSlots.filter((s) => s.status === 'blocked');
  const selectedAuto = selectedSlots.filter((s) => s.is_auto === true);

  function toggleSelect(slot) {
    if (slot.status === 'booked') return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slot.id)) next.delete(slot.id); else next.add(slot.id);
      return next;
    });
  }
  function exitBatch() { setBatchMode(false); setSelected(new Set()); }

  /**
   * 逐筆送出。刻意不用 Promise.all：一次選幾十格時同時打幾十個請求會被限流，
   * 而且任何一筆失敗都要能繼續處理其餘的，並如實回報「成功幾筆、失敗幾筆」。
   */
  async function runBatch(list, fn, verb) {
    if (!list.length || batchBusy) return;
    setBatchBusy(true);
    let ok = 0;
    const failed = [];
    for (const s of list) {
      try { await fn(s.id); ok += 1; } catch (e) {
        failed.push(e?.response?.data?.error || e.message || '未知錯誤');
      }
    }
    setBatchBusy(false);
    setSelected(new Set());
    refresh();
    if (failed.length) {
      toast.error(`${verb} ${ok} 個成功、${failed.length} 個失敗：${failed[0]}`);
    } else {
      toast.success(`已${verb} ${ok} 個時段`);
    }
  }

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
        {/* 主要動作：批量把不能上的時段排掉。 */}
        <div className="mb-3 flex gap-2">
          {!batchMode ? (
            <button onClick={() => setBatchMode(true)}
              disabled={selectableSlots.length === 0}
              className="flex-1 rounded-lg bg-brand-primary py-2 text-sm font-bold text-white active:bg-brand-teal disabled:opacity-40">
              批量編輯時段
            </button>
          ) : (
            <>
              <button onClick={() => setSelected(new Set(selectableSlots.map((s) => s.id)))}
                className="flex-1 rounded-lg border border-brand-primary/30 py-2 text-sm font-bold text-brand-primary active:bg-brand-primary/5">
                全選本{view === 'week' ? '週' : '月'}（{selectableSlots.length}）
              </button>
              <button onClick={exitBatch}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 active:bg-gray-50">
                完成
              </button>
            </>
          )}
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
              return (
                <DaySection key={d.toISOString()} date={d} slots={daySlots}
                  batchMode={batchMode} selected={selected}
                  onClickSlot={(slot) => (batchMode ? toggleSelect(slot) : setActiveSlot(slot))} />
              );
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
        {/* 批量模式時底部留白，免得動作列蓋住最後一天 */}
        {batchMode && <div className="h-36" />}
      </div>

      {batchMode && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 px-4 pb-6 pt-3 backdrop-blur">
          <div className="mx-auto max-w-[390px]">
            <p className="mb-2 text-center text-xs text-gray-600">
              已選 <span className="font-bold text-brand-primary">{selectedSlots.length}</span> 個時段
              {selectedSlots.length === 0 && '（點時段選取；已預約的不能選）'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => runBatch(selectedAvailable, slotsApi.block, '關閉')}
                disabled={batchBusy || selectedAvailable.length === 0}
                className="rounded-lg bg-gray-700 py-2.5 text-sm font-bold text-white active:bg-gray-800 disabled:opacity-40">
                {batchBusy ? '處理中…' : `設為不可預約（${selectedAvailable.length}）`}
              </button>
              <button
                onClick={() => runBatch(selectedBlocked, slotsApi.unblock, '重新開放')}
                disabled={batchBusy || selectedBlocked.length === 0}
                className="rounded-lg border border-brand-teal py-2.5 text-sm font-bold text-brand-teal active:bg-brand-teal/5 disabled:opacity-40">
                重新開放（{selectedBlocked.length}）
              </button>
            </div>
            <button
              onClick={() => runBatch(selectedSlots, slotsApi.remove, '刪除')}
              disabled={batchBusy || selectedSlots.length === 0 || selectedAuto.length > 0}
              className="mt-2 w-full rounded-lg border border-brand-error/40 py-2 text-sm font-bold text-brand-error active:bg-brand-error/5 disabled:opacity-40">
              刪除（{selectedSlots.length}）
            </button>
            {/* 刪除自動時段沒有意義：那一列被抹掉，下個產生週期會照場館營業時間
                原樣長回來，教練會以為排掉了其實沒有。持久的做法只有「設為不可
                預約」——產生器會沿用。與其給一顆按了等於沒按的按鈕，不如講清楚。 */}
            {selectedAuto.length > 0 && (
              <p className="mt-1.5 text-center text-[11px] leading-relaxed text-gray-500">
                選取中有 {selectedAuto.length} 個自動開放的時段，刪除後下個週期會再出現。
                請改用「設為不可預約」，那個會沿用到之後的週期。
              </p>
            )}
          </div>
        </div>
      )}

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

function DaySection({ date, slots, onClickSlot, batchMode = false, selected }) {
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
          {slots.map((s) => (
            <SlotChip key={s.id} slot={s} onClick={onClickSlot}
              batchMode={batchMode} selected={Boolean(selected && selected.has(s.id))} />
          ))}
        </div>
      )}
    </div>
  );
}
