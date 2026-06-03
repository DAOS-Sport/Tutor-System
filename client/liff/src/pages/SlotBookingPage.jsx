import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { slotsApi } from '../api/slots';
import ConfirmModal from '../components/ConfirmModal';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel, formatTWDate, formatTWDateTime } from '../utils/format';

export default function SlotBookingPage() {
  const { periodId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);

  function load() {
    setError(null);
    setData(null);
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 30);
    slotsApi.availableForPeriod(periodId, { from: from.toISOString(), to: to.toISOString() })
      .then((d) => setData(d))
      .catch((e) => {
        const msg = e?.response?.data?.error || '可預約時段載入失敗';
        setError(msg);
        toast.error(msg);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const slot of data?.slots || []) {
      const key = formatTWDate(slot.start_at);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(slot);
    }
    return Array.from(map.entries());
  }, [data]);

  async function confirmBook() {
    if (!selected) return;
    setBusy(true);
    try {
      await slotsApi.book(selected.id, periodId);
      toast.success('課程時段已預約成功');
      navigate('/my-courses', { replace: true });
    } catch (e) {
      toast.error(e?.response?.data?.error || '預約失敗，請改選其他時段');
      setSelected(null);
      load();
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="px-4 py-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">{error}</div>
        <button type="button" onClick={load} className="mt-4 w-full rounded-lg bg-brand-primary py-3 text-sm font-bold text-white">重新載入</button>
      </div>
    );
  }
  if (!data) return <LoadingSpinner fullPage label="載入可預約時段…" />;

  const period = data.period || {};
  const sessionsLeft = Number(data.sessions_left || 0);

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-3 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-brand-primary/10 px-2 py-0.5 text-xs font-medium text-brand-primary">
            {courseTypeLabel(period.course_type)}
          </span>
          <span className="rounded-md bg-brand-green/15 px-2 py-0.5 text-xs font-bold text-brand-green">
            尚可預約 {sessionsLeft} 堂
          </span>
        </div>
        <h1 className="mt-2 text-base font-bold text-gray-900">{period.coach_name || '教練'} · {period.venue_name || period.venue_id}</h1>
      </div>

      {sessionsLeft <= 0 ? (
        <EmptyBlock text="此課程期可預約堂數已用完" />
      ) : grouped.length === 0 ? (
        <EmptyBlock text="未來 30 天暫無可預約時段" />
      ) : (
        <div className="space-y-4">
          {grouped.map(([dateLabel, slots]) => (
            <section key={dateLabel}>
              <h2 className="mb-2 text-xs font-bold text-brand-primary">{dateLabel}</h2>
              <div className="grid grid-cols-2 gap-2">
                {slots.map((slot) => (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() => setSelected(slot)}
                    className="rounded-lg border border-brand-teal/30 bg-white px-3 py-3 text-left active:bg-brand-teal/5"
                  >
                    <div className="text-sm font-bold text-brand-primary">
                      {new Date(slot.start_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    </div>
                    <div className="mt-1 text-[11px] text-gray-500">{slot.duration_minutes || 60} 分鐘</div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!selected}
        title="確認預約時段"
        confirmLabel="確認預約"
        busy={busy}
        onCancel={() => setSelected(null)}
        onConfirm={confirmBook}
      >
        <div className="text-sm leading-6 text-gray-700">
          {selected ? formatTWDateTime(selected.start_at) : ''}
          <br />
          {period.venue_name || period.venue_id} · {selected?.duration_minutes || 60} 分鐘
        </div>
      </ConfirmModal>
    </div>
  );
}

function EmptyBlock({ text }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
      {text}
    </div>
  );
}
