import React, { useEffect, useMemo, useState } from 'react';
import { slotsApi } from '../../api/slots';
import { addDaysToTaipeiYMD, todayTaipeiYMD } from '../../utils/format';
import { cleanVenueList } from '../../utils/venues';

const DURATION_MINUTES = 60; // 一堂課固定 60 分鐘，不開放教練調整

const WEEKDAYS = [
  { v: 0, label: '日' }, { v: 1, label: '一' }, { v: 2, label: '二' },
  { v: 3, label: '三' }, { v: 4, label: '四' }, { v: 5, label: '五' }, { v: 6, label: '六' },
];

// 可開課整點：起始 06:00 ~ 21:00（最後一堂 21:00～22:00），共 16 個
const START_HOURS = Array.from({ length: 16 }, (_, i) => 6 + i);
const HOUR_OPTIONS = START_HOURS.map((h) => `${String(h).padStart(2, '0')}:00`);
function hourRangeLabel(t) {
  const h = parseInt(t.slice(0, 2), 10);
  return `${t}～${String(h + 1).padStart(2, '0')}:00`;
}

function plusDaysStr(n) { return addDaysToTaipeiYMD(todayTaipeiYMD(), n); }

/**
 * 批量新增槽位（範圍 + 星期 + 時段陣列）
 */
export default function BatchAddSlotModal({ coachId, venueIds, venueNameMap, onClose, onDone, onError }) {
  const cleanVenueIds = useMemo(() => cleanVenueList(venueIds), [venueIds]);
  const [from, setFrom] = useState(todayTaipeiYMD());
  const [to, setTo] = useState(plusDaysStr(13));
  const [weekdays, setWeekdays] = useState([1, 3, 5]);
  const [times, setTimes] = useState(['14:00', '15:00', '16:00']);
  const [venueId, setVenueId] = useState(() => cleanVenueIds[0] || '');
  const [busy, setBusy] = useState(false);

  const venueName = (v) => (venueNameMap && venueNameMap[v]) || `${v} 館`;

  useEffect(() => {
    if (!cleanVenueIds.length) {
      setVenueId('');
      return;
    }
    if (!cleanVenueIds.includes(venueId)) {
      setVenueId(cleanVenueIds[0]);
    }
  }, [cleanVenueIds, venueId]);

  function toggleWd(v) {
    setWeekdays((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v].sort());
  }
  function updateTime(i, v) {
    setTimes((prev) => prev.map((t, idx) => (idx === i ? v : t)));
  }
  function firstUnusedHour(current) {
    return HOUR_OPTIONS.find((h) => !current.includes(h));
  }
  function addTime() {
    setTimes((prev) => {
      const next = firstUnusedHour(prev);
      return next ? [...prev, next] : prev;
    });
  }
  function removeTime(i) { setTimes((p) => p.filter((_, idx) => idx !== i)); }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    if (weekdays.length === 0) { onError && onError('請至少勾選一個星期'); return; }
    if (times.length === 0) { onError && onError('請至少加入一個時段'); return; }
    if (!venueId) { onError && onError('此教練尚未設定可排課場館'); return; }
    const uniqueTimes = Array.from(new Set(times)); // 去重保險
    setBusy(true);
    try {
      const r = await slotsApi.batch({
        coach_id: coachId, venue_id: venueId,
        weekdays, times: uniqueTimes, from, to, duration_minutes: DURATION_MINUTES,
      });
      onDone && onDone(r);
      onClose();
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || '批量建立失敗';
      onError ? onError(msg) : alert(msg);
    } finally {
      setBusy(false);
    }
  }

  const allHoursUsed = times.length >= HOUR_OPTIONS.length;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-[390px] overflow-y-auto rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold text-brand-primary">批量新增槽位</h3>
          <button type="button" onClick={onClose} className="text-sm text-gray-500">關閉</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <Field label="起始日期">
              <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)}
                className="block w-full min-w-0 box-border appearance-none rounded-lg border border-gray-300 px-3 py-2" />
            </Field>
            <Field label="結束日期">
              <input type="date" required value={to} min={from} onChange={(e) => setTo(e.target.value)}
                className="block w-full min-w-0 box-border appearance-none rounded-lg border border-gray-300 px-3 py-2" />
            </Field>
          </div>

          <Field label="重複星期">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((w) => {
                const on = weekdays.includes(w.v);
                return (
                  <button key={w.v} type="button" onClick={() => toggleWd(w.v)}
                    className={`h-9 w-9 rounded-full text-xs font-medium ${on ? 'bg-brand-primary text-white' : 'border border-gray-300 text-gray-600'}`}>
                    {w.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="每天時段（可加多筆）">
            <div className="space-y-2">
              {times.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select value={t} onChange={(e) => updateTime(i, e.target.value)}
                    className="block min-w-0 flex-1 box-border appearance-none rounded-lg border border-gray-300 px-3 py-2">
                    {HOUR_OPTIONS.map((h) => (
                      // 已被其他列選走的時段 disable，達成「每個時段每天只能出現一次」
                      <option key={h} value={h} disabled={h !== t && times.includes(h)}>
                        {hourRangeLabel(h)}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => removeTime(i)}
                    className="shrink-0 text-xs text-brand-error">刪除</button>
                </div>
              ))}
              <button type="button" onClick={addTime} disabled={allHoursUsed}
                className="w-full rounded-lg border border-dashed border-gray-300 py-1.5 text-xs text-gray-500 disabled:opacity-40">
                {allHoursUsed ? '已加入所有可開課時段' : '＋ 新增時段'}
              </button>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="時長">
              <div className="w-full min-w-0 box-border rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-gray-500">
                60 分鐘
              </div>
            </Field>
            <Field label="場館">
              <select value={venueId} onChange={(e) => setVenueId(e.target.value)} disabled={!cleanVenueIds.length}
                className="block w-full min-w-0 box-border appearance-none rounded-lg border border-gray-300 px-3 py-2">
                {!cleanVenueIds.length && <option value="">尚未設定場館</option>}
                {cleanVenueIds.map((v) => <option key={v} value={v}>{venueName(v)}</option>)}
              </select>
            </Field>
          </div>

          <p className="text-[11px] text-gray-400">
            系統會自動跳過時段衝突的槽位，回傳建立 / 跳過數量。
          </p>

          <button type="submit" disabled={busy}
            className="mt-2 w-full rounded-lg bg-brand-primary py-3 font-bold text-white active:bg-brand-teal disabled:opacity-50">
            {busy ? '送出中…' : '批量建立'}
          </button>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}
