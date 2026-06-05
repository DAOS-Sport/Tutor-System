import React, { useState } from 'react';
import { slotsApi } from '../../api/slots';
import { todayTaipeiYMD } from '../../utils/format';

function taipeiInputToIso(date, time) {
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

/**
 * 單筆新增槽位
 */
export default function AddSlotModal({ coachId, venueIds, onClose, onCreated, onError }) {
  const [date, setDate] = useState(todayTaipeiYMD());
  const [time, setTime] = useState('14:00');
  const [duration, setDuration] = useState(60);
  const [venueId, setVenueId] = useState(venueIds?.[0] || 'B');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(null);

  async function checkConflict() {
    if (!date || !time) return;
    const start = taipeiInputToIso(date, time);
    try {
      const r = await slotsApi.previewConflict({ coach_id: coachId, start_at: start, duration_minutes: duration });
      setConflict(r.has_conflict ? r : null);
    } catch { setConflict(null); }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const start = taipeiInputToIso(date, time);
    setBusy(true);
    try {
      const slot = await slotsApi.create({
        coach_id: coachId, venue_id: venueId, start_at: start,
        duration_minutes: duration, notes: notes || null,
      });
      onCreated && onCreated(slot);
      onClose();
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || '新增失敗';
      onError ? onError(msg) : alert(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-[390px] rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold text-brand-primary">新增單一槽位</h3>
          <button type="button" onClick={onClose} className="text-sm text-gray-500">關閉</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3 text-sm">
          <Field label="日期">
            <input type="date" required value={date} onChange={(e) => { setDate(e.target.value); setConflict(null); }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2" />
          </Field>
          <Field label="開始時間">
            <input type="time" required value={time} onChange={(e) => { setTime(e.target.value); setConflict(null); }}
              onBlur={checkConflict} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
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
          <Field label="備註（選填）">
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={50}
              className="w-full rounded-lg border border-gray-300 px-3 py-2" />
          </Field>
          {conflict && (
            <div className="rounded-lg border border-brand-error/30 bg-brand-error-soft p-2 text-xs text-brand-error">
              ⚠ 偵測到時段衝突，送出將失敗
            </div>
          )}
          <button type="submit" disabled={busy}
            className="mt-2 w-full rounded-lg bg-brand-primary py-3 font-bold text-white active:bg-brand-teal disabled:opacity-50">
            {busy ? '送出中…' : '建立槽位'}
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
