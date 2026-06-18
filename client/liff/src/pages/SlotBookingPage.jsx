import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { slotsApi } from '../api/slots';
import ConfirmModal from '../components/ConfirmModal';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { addDaysToTaipeiYMD, courseTypeLabel, formatTWDate, formatTWTime, formatTWYMD, todayTaipeiYMD } from '../utils/format';

// 早上／下午／晚上：以開始時間的「時」分段。色調沿用品牌主色（晨=amber、午=teal、晚=navy），維持 App 主色調。
const BANDS = [
  { key: 'morning',   label: '早上', emoji: '🌅', tone: 'amber',   test: (h) => h < 12 },
  { key: 'afternoon', label: '下午', emoji: '☀️', tone: 'teal',    test: (h) => h >= 12 && h < 18 },
  { key: 'evening',   label: '晚上', emoji: '🌙', tone: 'primary', test: (h) => h >= 18 },
];

const TONE = {
  amber:   { rail: 'border-brand-amber',   iconBg: 'bg-brand-amber/15',   chipBg: 'bg-brand-amber/10',   chipText: 'text-brand-amber',   selBorder: 'border-brand-amber',   selBg: 'bg-brand-amber/10',   cardBorder: 'border-brand-amber/30' },
  teal:    { rail: 'border-brand-teal',    iconBg: 'bg-brand-teal/15',    chipBg: 'bg-brand-teal/10',    chipText: 'text-brand-teal',    selBorder: 'border-brand-teal',    selBg: 'bg-brand-teal/10',    cardBorder: 'border-brand-teal/30' },
  primary: { rail: 'border-brand-primary', iconBg: 'bg-brand-primary/15', chipBg: 'bg-brand-primary/10', chipText: 'text-brand-primary', selBorder: 'border-brand-primary', selBg: 'bg-brand-primary/10', cardBorder: 'border-brand-primary/30' },
};

const slotHour = (s) => Number(formatTWTime(s.start_at).slice(0, 2)) || 0;

export default function SlotBookingPage() {
  const { periodId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set()); // 跨日多選，存 slot.id
  const [activeDate, setActiveDate] = useState('');
  const [capHit, setCapHit] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  function load() {
    setError(null);
    setData(null);
    setSelected(new Set());
    setCapHit(false);
    const from = todayTaipeiYMD();
    const to = addDaysToTaipeiYMD(from, 30);
    slotsApi.availableForPeriod(periodId, { from, to })
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

  const period = data?.period || {};
  const quota = Number(data?.sessions_left || 0);
  const isGroup = Number(period.course_type) > 1;

  const slotById = useMemo(() => {
    const m = new Map();
    (data?.slots || []).forEach((s) => m.set(s.id, s));
    return m;
  }, [data]);

  // 依日期彙整（每日時段已依時間排序）
  const byDate = useMemo(() => {
    const m = new Map();
    for (const s of data?.slots || []) {
      const ymd = formatTWYMD(s.start_at);
      if (!m.has(ymd)) m.set(ymd, []);
      m.get(ymd).push(s);
    }
    for (const arr of m.values()) arr.sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
    return m;
  }, [data]);

  // 日期列：只列出教練實際有開放時段的日期
  const days = useMemo(() => Array.from(byDate.keys()).sort().map((ymd) => {
    const first = byDate.get(ymd)[0];
    const lbl = formatTWDate(first.start_at);
    return { date: ymd, wd: (lbl.match(/（([^）]+)）/) || [])[1] || '', dd: ymd.slice(8) };
  }), [byDate]);

  // 載入後或日期消失時，預設選第一天
  useEffect(() => {
    if (days.length && !days.some((d) => d.date === activeDate)) setActiveDate(days[0].date);
  }, [days, activeDate]);

  const count = selected.size;
  const remaining = Math.max(0, quota - count);

  function dayCount(date) {
    let n = 0;
    selected.forEach((id) => { const s = slotById.get(id); if (s && formatTWYMD(s.start_at) === date) n += 1; });
    return n;
  }

  function toggle(id) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) { n.delete(id); setCapHit(false); return n; }
      if (n.size >= quota) { setCapHit(true); return prev; }
      n.add(id);
      return n;
    });
  }

  // 目前日期、依早/午/晚分段（無時段的段落不顯示）
  const bandGroups = useMemo(() => {
    const list = byDate.get(activeDate) || [];
    return BANDS.map((band) => ({ band, slots: list.filter((s) => band.test(slotHour(s))) }))
      .filter((g) => g.slots.length > 0);
  }, [byDate, activeDate]);

  // 確認視窗用：已選時段依日期彙整
  const summary = useMemo(() => {
    const m = new Map();
    selected.forEach((id) => {
      const s = slotById.get(id);
      if (!s) return;
      const ymd = formatTWYMD(s.start_at);
      if (!m.has(ymd)) m.set(ymd, { label: formatTWDate(s.start_at), times: [] });
      m.get(ymd).times.push(formatTWTime(s.start_at));
    });
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, label: v.label, times: v.times.sort() }));
  }, [selected, slotById]);

  async function submit() {
    const ids = [...selected];
    if (!ids.length || busy) return;
    setBusy(true);
    let ok = 0;
    const fails = [];
    // 後端為單槽預約，依序送出；逐筆累計成功/失敗，便於部分失敗時回報。
    for (const id of ids) {
      try { await slotsApi.book(id, periodId); ok += 1; }
      catch (e) { fails.push(e?.response?.data?.error || '時段已被預訂'); }
    }
    setBusy(false);
    setConfirmOpen(false);
    if (ok === ids.length) {
      toast.success(isGroup ? `已送出 ${ok} 個時段，等待同組家長確認` : `已預約 ${ok} 堂`);
      navigate('/my-courses', { replace: true });
    } else if (ok > 0) {
      toast.warning(`${ok} 堂預約成功，${ids.length - ok} 堂失敗（時段已被預訂），請重新確認剩餘時段`);
      load();
    } else {
      toast.error(fails[0] || '預約失敗，請改選其他時段');
      load();
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

  // 資訊卡（教練/課程）：所有狀態共用
  const infoCard = (
    <div className="px-4 pt-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-brand-primary/10 px-2 py-0.5 text-xs font-semibold text-brand-primary">
            {courseTypeLabel(period.course_type)}
          </span>
          <span className="rounded-md bg-brand-green/15 px-2 py-0.5 text-xs font-semibold text-brand-green">
            尚可預約 {remaining} 堂
          </span>
        </div>
        <div className="mt-2 text-lg font-bold text-gray-900">{period.coach_name || '教練'} · {period.venue_name || period.venue_id}</div>
        {isGroup && (
          <div className="mt-1.5 flex items-start gap-1.5 text-sm text-gray-500">
            <InfoIcon className="mt-0.5 shrink-0 text-gray-400" />
            <span>團班時段送出後，需等待同組家庭確認才會正式成立。</span>
          </div>
        )}
      </div>
    </div>
  );

  if (quota <= 0) {
    return <div className="pb-6">{infoCard}<div className="px-4 pt-4"><EmptyBlock text="此課程期可預約堂數已用完" /></div></div>;
  }
  if (days.length === 0) {
    return <div className="pb-6">{infoCard}<div className="px-4 pt-4"><EmptyBlock text="目前教練尚未開放可上課時間，請靜候教練更新可上課時間。" /></div></div>;
  }

  return (
    <div className="flex min-h-[calc(100vh-3rem)] flex-col">
      {infoCard}

      {/* 日期列（捲動時釘在 App Header 下方） */}
      <div className="sticky top-12 z-10 mt-4 border-b border-gray-100 bg-white px-4 py-3">
        <div className="flex gap-2 overflow-x-auto">
          {days.map((d) => (
            <DayChip key={d.date} d={d} active={d.date === activeDate} count={dayCount(d.date)}
              onClick={() => { setActiveDate(d.date); setCapHit(false); }} />
          ))}
        </div>
      </div>

      {/* 時段（依早/午/晚分段、水平捲動） */}
      <div className="flex-1 space-y-5 px-4 py-4">
        {capHit && (
          <div className="rounded-xl bg-brand-amber/10 px-3 py-2 text-xs font-medium text-brand-amber">
            已達本期可預約上限（{quota} 堂），請先取消其他時段再選。
          </div>
        )}
        {bandGroups.length === 0 ? (
          <EmptyBlock text="這天教練尚未開放時段，請改選其他日期。" />
        ) : (
          bandGroups.map(({ band, slots }) => (
            <Band key={band.key} band={band} slots={slots} isSel={(id) => selected.has(id)} onToggle={toggle} />
          ))
        )}
      </div>

      {/* 送出列（釘在底部） */}
      <div className="sticky bottom-0 z-10 border-t border-gray-100 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500">
            已選 <span className="font-bold text-brand-primary">{count}</span> 堂・尚可選 {remaining} 堂
          </div>
          <button
            type="button"
            disabled={count === 0 || busy}
            onClick={() => setConfirmOpen(true)}
            className="rounded-lg bg-brand-primary px-5 py-2.5 text-sm font-bold text-white active:bg-brand-teal disabled:opacity-50"
          >
            送出預約
          </button>
        </div>
      </div>

      <ConfirmModal
        open={confirmOpen}
        title="確認預約時段"
        confirmLabel={`確認預約 ${count} 堂`}
        busy={busy}
        onCancel={() => { if (!busy) setConfirmOpen(false); }}
        onConfirm={submit}
      >
        <div className="space-y-2">
          {isGroup && <p className="text-xs text-gray-500">團班時段送出後，需等待同組家庭確認才會正式成立。</p>}
          {summary.map((g) => (
            <div key={g.date} className="rounded-lg bg-gray-50 px-3 py-2">
              <div className="text-xs font-bold text-brand-primary">{g.label}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {g.times.map((t) => (
                  <span key={t} className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs tabular-nums text-gray-700">{t}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ConfirmModal>
    </div>
  );
}

// 時段格（固定寬度、shrink-0，置於水平捲動列）
function Slot({ slot, tone, selected, onClick }) {
  const t = TONE[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ width: 84 }}
      className={`relative shrink-0 rounded-2xl border-2 px-2 py-3 text-center transition active:scale-95 ${
        selected ? `${t.selBorder} ${t.selBg}` : `bg-white ${t.cardBorder}`
      }`}
    >
      {selected && (
        <span className={`absolute right-1 top-1 ${t.chipText}`}><CheckIcon /></span>
      )}
      <div className="text-base font-semibold tabular-nums text-gray-900">{formatTWTime(slot.start_at)}</div>
      <div className="mt-0.5 text-xs text-gray-400">{slot.duration_minutes || 60} 分鐘</div>
    </button>
  );
}

function DayChip({ d, active, count, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ minWidth: 56 }}
      className={`relative shrink-0 rounded-2xl px-3 py-2 text-center transition ${
        active ? 'bg-brand-primary text-white shadow' : 'bg-gray-100 text-gray-700 active:bg-gray-200'
      }`}
    >
      <div className={`text-xs ${active ? 'text-white/70' : 'opacity-70'}`}>{d.wd}</div>
      <div className="text-base font-semibold tabular-nums leading-tight">{d.dd}</div>
      {count > 0 && (
        <span className="absolute -top-1.5 -right-1.5 grid h-5 w-5 place-items-center rounded-full bg-brand-green text-xs font-semibold text-white shadow">
          {count}
        </span>
      )}
    </button>
  );
}

function Band({ band, slots, isSel, onToggle }) {
  const t = TONE[band.tone];
  return (
    <section className={`border-l-4 ${t.rail} pl-3`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`grid h-8 w-8 place-items-center rounded-full text-base ${t.iconBg}`}>{band.emoji}</div>
          <div className="text-sm font-semibold text-gray-900">{band.label}</div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.chipBg} ${t.chipText}`}>可預約 {slots.length}</span>
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {slots.map((s) => (
          <Slot key={s.id} slot={s} tone={band.tone} selected={isSel(s.id)} onClick={() => onToggle(s.id)} />
        ))}
      </div>
    </section>
  );
}

function EmptyBlock({ text }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
      {text}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function InfoIcon({ className = '' }) {
  return (
    <svg className={className} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
    </svg>
  );
}
