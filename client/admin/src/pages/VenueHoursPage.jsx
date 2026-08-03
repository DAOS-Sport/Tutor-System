import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { venueHoursApi } from '../api/venueHours';
import { venuesApi } from '../api/venues';

/**
 * 場館營業時間設定（模組 1）
 *
 * 這頁是「自動時段產生器」的唯一時間來源：產生器依這裡的每週營業時間切格子，
 * 並跳過特殊日期休館。改這裡會影響隔日 02:30 產生的時段，因此限 admin／場館主管。
 *
 * 明確不做的事：不動任何既有時段。休館設定只影響「未來還沒產生的」，
 * 已經被家長預約的堂不會因為設了休館就消失——那必須由櫃檯另行處理，
 * 所以新增休館時後端會回報當天已有幾筆預約。
 */
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const EMPTY_DAY = { open_time: '', close_time: '', slot_minutes: 60, closed: true };

function TimeInput({ value, onChange, disabled, invalid, label }) {
  return (
    <input
      type="time" value={value || ''} disabled={disabled} aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-lg border px-2 py-1.5 text-sm disabled:bg-gray-100 disabled:text-gray-400
        ${invalid ? 'border-brand-error bg-brand-error-soft' : 'border-gray-300'}`}
    />
  );
}

function DayRow({ wd, row, onChange, readOnly }) {
  const closed = row.closed;
  const invalid = !closed && row.open_time && row.close_time && row.close_time <= row.open_time;
  return (
    <div className="grid grid-cols-[3.5rem_1fr] items-start gap-2 border-b border-gray-100 py-2.5 last:border-0
                    sm:grid-cols-[4rem_auto_auto_auto_1fr] sm:items-center">
      <span className="pt-1.5 text-sm font-bold text-gray-700 sm:pt-0">{WEEKDAYS[wd]}</span>

      <div className="space-y-2 sm:contents">
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          <input type="checkbox" checked={closed} disabled={readOnly}
            onChange={(e) => onChange({ ...row, closed: e.target.checked })} />
          休館
        </label>

        <div className="flex items-center gap-1.5">
          <TimeInput label={`${WEEKDAYS[wd]} 開店`} value={row.open_time} disabled={closed || readOnly}
            invalid={invalid} onChange={(v) => onChange({ ...row, open_time: v })} />
          <span className="text-gray-400">–</span>
          <TimeInput label={`${WEEKDAYS[wd]} 打烊`} value={row.close_time} disabled={closed || readOnly}
            invalid={invalid} onChange={(v) => onChange({ ...row, close_time: v })} />
        </div>

        <div className="flex items-center gap-1 text-xs text-gray-500">
          <span>每格</span>
          <input type="number" min="15" max="480" step="15" value={row.slot_minutes}
            disabled={closed || readOnly}
            onChange={(e) => onChange({ ...row, slot_minutes: Number(e.target.value) })}
            className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm disabled:bg-gray-100 disabled:text-gray-400" />
          <span>分</span>
        </div>

        {invalid && <span className="text-[11px] font-bold text-brand-error">打烊須晚於開店</span>}
      </div>
    </div>
  );
}

export default function VenueHoursPage() {
  const { user } = useAuth();
  const toast = useToast();
  const readOnly = !['admin', 'manager'].includes(user?.role);

  const [venues, setVenues] = useState([]);
  const [venueId, setVenueId] = useState('');
  const [week, setWeek] = useState(() => WEEKDAYS.map(() => ({ ...EMPTY_DAY })));
  const [missing, setMissing] = useState([]);
  const [closedDates, setClosedDates] = useState([]);
  const [newClosed, setNewClosed] = useState({ closed_date: '', reason: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([venuesApi.list(), venueHoursApi.list()])
      .then(([vs, data]) => {
        if (!alive) return;
        const active = (vs || []).filter((v) => v.is_active !== false);
        setVenues(active);
        setMissing(data.venues_without_hours || []);
        setVenueId((prev) => prev || active[0]?.id || '');
        window.__vh = data.hours || [];
      })
      .catch(() => alive && toast.error('載入場館營業時間失敗'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [reload, toast]);

  // 切換場館時把該館的設定攤成 7 天（沒設定的那天＝休館）
  useEffect(() => {
    if (!venueId) return;
    const rows = (window.__vh || []).filter((h) => h.venue_id === venueId);
    setWeek(WEEKDAYS.map((_, wd) => {
      const r = rows.find((x) => Number(x.weekday) === wd);
      return r
        ? { open_time: r.open_time, close_time: r.close_time, slot_minutes: r.slot_minutes, closed: r.is_active === false }
        : { ...EMPTY_DAY };
    }));
    venueHoursApi.listClosed({ venueId }).then(setClosedDates).catch(() => setClosedDates([]));
  }, [venueId, loading]);

  const venueName = useMemo(
    () => venues.find((v) => v.id === venueId)?.name || venueId,
    [venues, venueId]
  );

  const invalidDays = useMemo(
    () => week.map((r, wd) => (!r.closed && (!r.open_time || !r.close_time || r.close_time <= r.open_time) ? wd : -1))
      .filter((x) => x >= 0),
    [week]
  );

  async function save() {
    if (readOnly) return toast.error('僅系統管理員與場館主管可修改');
    if (invalidDays.length) {
      return toast.error(`${invalidDays.map((d) => WEEKDAYS[d]).join('、')} 的時間不完整或顛倒`);
    }
    setBusy(true);
    try {
      const hours = week
        .map((r, wd) => (r.closed ? null : {
          weekday: wd, open_time: r.open_time, close_time: r.close_time,
          slot_minutes: Number(r.slot_minutes) || 60, is_active: true,
        }))
        .filter(Boolean);
      await venueHoursApi.save(venueId, hours);
      toast.success(`已儲存「${venueName}」的營業時間`);
      setReload((x) => x + 1);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 403) toast.error('權限不足：僅系統管理員與場館主管可修改');
      else toast.error(err?.response?.data?.error || '儲存失敗');
    } finally {
      setBusy(false);
    }
  }

  async function addClosed() {
    if (!newClosed.closed_date) return toast.error('請選擇休館日期');
    setBusy(true);
    try {
      const r = await venueHoursApi.addClosed({ venue_id: venueId, ...newClosed });
      toast.success(r.note || '已設定休館日');
      if (r.note) toast.error(r.note);   // 當天已有預約 → 用錯誤色再提醒一次，避免被忽略
      setNewClosed({ closed_date: '', reason: '' });
      setClosedDates(await venueHoursApi.listClosed({ venueId }));
    } catch (err) {
      toast.error(err?.response?.data?.error || '設定休館日失敗');
    } finally {
      setBusy(false);
    }
  }

  async function removeClosed(id) {
    setBusy(true);
    try {
      await venueHoursApi.removeClosed(id);
      toast.success('已移除休館日');
      setClosedDates(await venueHoursApi.listClosed({ venueId }));
    } catch (err) {
      toast.error(err?.response?.data?.error || '移除失敗');
    } finally { setBusy(false); setConfirmDelete(null); }
  }

  if (loading) return <LoadingSpinner label="載入場館營業時間…" />;

  return (
    <div className="pb-8">
      <PageHeader title="場館營業時間"
        subtitle="自動產生家教可預約時段的時間來源。修改後於隔日凌晨產生時生效，不會變動任何既有時段。" />

      {readOnly && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          你目前的角色只能檢視，無法修改。
        </div>
      )}

      {missing.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          尚未設定營業時間的啟用場館：{missing.map((m) => m.name).join('、')}
          <span className="ml-1 text-amber-600">（這些場館不會產生任何可預約時段）</span>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-1.5">
        {venues.map((v) => (
          <button key={v.id} type="button" onClick={() => setVenueId(v.id)}
            className={`rounded-full px-3 py-1.5 text-sm font-bold ${
              v.id === venueId ? 'bg-brand-teal text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}>
            {v.name}
          </button>
        ))}
      </div>

      <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-bold text-brand-primary">每週營業時間</h3>
        {week.map((row, wd) => (
          <DayRow key={wd} wd={wd} row={row} readOnly={readOnly}
            onChange={(next) => setWeek((prev) => prev.map((x, i) => (i === wd ? next : x)))} />
        ))}
        <div className="mt-4 flex items-center justify-end gap-2">
          {invalidDays.length > 0 && (
            <span className="text-xs font-bold text-brand-error">
              {invalidDays.map((d) => WEEKDAYS[d]).join('、')} 的時間不完整或顛倒
            </span>
          )}
          <button type="button" onClick={save} disabled={busy || readOnly || invalidDays.length > 0}
            className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {busy ? '儲存中…' : '儲存營業時間'}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-bold text-brand-primary">特殊日期休館</h3>
        <p className="mb-3 text-[11px] leading-snug text-gray-400">
          用於國定假日、場地整修等單日例外。設定後該日不再產生新的可預約時段；
          <b>已經被預約的堂不會自動取消</b>，需另行處理。
        </p>

        {!readOnly && (
          <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_auto]">
            <input type="date" value={newClosed.closed_date} aria-label="休館日期"
              onChange={(e) => setNewClosed({ ...newClosed, closed_date: e.target.value })}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
            <input type="text" placeholder="原因（選填，例如：中元節公休）" value={newClosed.reason}
              onChange={(e) => setNewClosed({ ...newClosed, reason: e.target.value })}
              className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
            <button type="button" onClick={addClosed} disabled={busy}
              className="rounded-lg border border-brand-teal px-3 py-1.5 text-sm font-bold text-brand-teal disabled:opacity-50">
              新增休館日
            </button>
          </div>
        )}

        {closedDates.length === 0 ? (
          <p className="text-sm text-gray-400">此場館目前沒有特殊休館日。</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {closedDates.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                <span className="flex items-center gap-2">
                  <StatusBadge tone="gray">{c.closed_date}</StatusBadge>
                  <span className="text-gray-600">{c.reason || '—'}</span>
                </span>
                {!readOnly && (
                  <button type="button" onClick={() => setConfirmDelete(c)}
                    className="text-xs font-bold text-brand-error hover:underline">移除</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete ? `移除 ${confirmDelete.closed_date} 的休館設定？` : ''}
        confirmLabel="移除" tone="danger" busy={busy}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => removeClosed(confirmDelete.id)}
      >
        移除後，該日會依每週營業時間恢復產生可預約時段。
      </ConfirmDialog>
    </div>
  );
}