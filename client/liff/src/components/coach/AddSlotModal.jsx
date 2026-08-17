import React, { useEffect, useMemo, useState } from 'react';
import DateTimePicker from '../../../../shared/DateTimePicker.jsx';
import { slotsApi } from '../../api/slots';
import { todayTaipeiYMD } from '../../utils/format';
import { cleanVenueList } from '../../utils/venues';

const DURATION_MINUTES = 60; // 一堂課固定 60 分鐘，不開放教練調整

function taipeiInputToIso(date, time) {
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

/**
 * 單筆新增槽位
 */
export default function AddSlotModal({ coachId, venueIds, venueNameMap, onClose, onCreated, onError }) {
  const cleanVenueIds = useMemo(() => cleanVenueList(venueIds), [venueIds]);
  const [date, setDate] = useState(todayTaipeiYMD());
  const [time, setTime] = useState('14:00');
  const [venueId, setVenueId] = useState(() => cleanVenueIds[0] || '');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(null);

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

  // 原本掛在時間輸入框的 onBlur。改用共用選擇器後沒有「離開欄位」這個時機，
  // 改成 date/time 任一變動就重查 —— 比原本更早給回饋，而且不會因為使用者
  // 直接按送出（從未 blur）而整個跳過衝突檢查。
  useEffect(() => { checkConflict(); }, [date, time]); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkConflict() {
    if (!date || !time) { setConflict(null); return; }
    const start = taipeiInputToIso(date, time);
    try {
      const r = await slotsApi.previewConflict({ coach_id: coachId, start_at: start, duration_minutes: DURATION_MINUTES });
      setConflict(r.has_conflict ? r : null);
    } catch { setConflict(null); }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    if (!venueId) {
      onError && onError('此教練尚未設定可排課場館');
      return;
    }
    const start = taipeiInputToIso(date, time);
    setBusy(true);
    try {
      const slot = await slotsApi.create({
        coach_id: coachId, venue_id: venueId, start_at: start,
        duration_minutes: DURATION_MINUTES,
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
            <DateTimePicker value={date} onChange={(v) => { setDate(v); setConflict(null); }}
              placeholder="選擇日期" className="min-w-0" />
          </Field>
          <Field label="開始時間">
            <DateTimePicker mode="time" value={time}
              onChange={(v) => { setTime(v); setConflict(null); }} className="min-w-0" />
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
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}
