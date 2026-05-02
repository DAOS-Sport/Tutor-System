import React, { useState } from 'react';
import { slotsApi } from '../../api/slots';

const WEEKDAYS = [
  { v: 0, label: '日' }, { v: 1, label: '一' }, { v: 2, label: '二' },
  { v: 3, label: '三' }, { v: 4, label: '四' }, { v: 5, label: '五' }, { v: 6, label: '六' },
];

function todayStr() { const d = new Date(); return d.toISOString().slice(0, 10); }
function plusDaysStr(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

/**
 * 批量新增槽位（範圍 + 星期 + 時段陣列）
 */
export default function BatchAddSlotModal({ coachId, venueIds, onClose, onDone, onError }) {
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(plusDaysStr(13));
  const [weekdays, setWeekdays] = useState([1, 3, 5]);
  const [times, setTimes] = useState(['14:00', '15:00', '16:00']);
  const [duration, setDuration] = useState(60);
  const [venueId, setVenueId] = useState(venueIds?.[0] || 'B');
  const [busy, setBusy] = useState(false);

  function toggleWd(v) {
    setWeekdays((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v].sort());
  }
  function updateTime(i, v) {
    setTimes((prev) => prev.map((t, idx) => (idx === i ? v : t)));
  }
  function addTime() { setTimes((p) => [...p, '17:00']); }
  function removeTime(i) { setTimes((p) => p.filter((_, idx) => idx !== i)); }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    if (weekdays.length === 0) { onError && onError('請至少勾選一個星期'); return; }
    if (times.length === 0) { onError && onError('請至少加入一個時段'); return; }
    setBusy(true);
    try {
      const r = await slotsApi.batch({
        coach_id: coachId, venue_id: venueId,
        weekdays, times, from, to, duration_minutes: duration,
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
                className="w-full rounded-lg border border-gray-300 px-3 py-2" />
            </Field>
            <Field label="結束日期">
              <input type="date" required value={to} min={from} onChange={(e) => setTo(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2" />
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
                  <input type="time" value={t} onChange={(e) => updateTime(i, e.target.value)}
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2" />
                  <button type="button" onClick={() => removeTime(i)}
                    className="text-xs text-brand-error">刪除</button>
                </div>
              ))}
              <button type="button" onClick={addTime}
                className="w-full rounded-lg border border-dashed border-gray-300 py-1.5 text-xs text-gray-500">
                ＋ 新增時段
              </button>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="時長（分鐘）">
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2">
                {[60, 90, 120].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="場館">
              <select value={venueId} onChange={(e) => setVenueId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2">
                {venueIds.map((v) => <option key={v} value={v}>{v}</option>)}
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
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}
