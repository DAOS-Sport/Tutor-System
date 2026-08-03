// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔凍結範圍：團班預約即時成立文案（不得改回「等待同組確認」）。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
import React, { useEffect, useMemo, useState } from 'react';
import { slotsApi } from '../api/slots';
import ConfirmModal from './ConfirmModal';
import LoadingSpinner from './LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { addDaysToTaipeiYMD, courseTypeLabel, formatTWDate, formatTWTime, formatTWYMD, todayTaipeiYMD } from '../utils/format';

// 早上／下午／晚上：以開始時間的「時」分段。色調沿用品牌主色（晨=amber、午=teal、晚=navy）。
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

/**
 * 單選時段選擇器（共用）：/book-slot 獨立頁 與 上課記錄頁內嵌摺疊 皆用此元件。
 *  - 單選：一次只選一個時段，選新覆蓋舊。
 *  - props:
 *      periodId  課程期 id（必填）
 *      onBooked  預約成功後回呼（如導頁或重載）
 *      embedded  true＝內嵌（不顯示資訊卡、不黏底，較精簡）；false＝獨立頁
 */
export default function SlotPicker({ periodId, onBooked, embedded = false }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [activeDate, setActiveDate] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);   // 首次預約提示（模組 1）
  const [busy, setBusy] = useState(false);

  function load() {
    setError(null);
    setData(null);
    setSelectedId(null);
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

  const days = useMemo(() => Array.from(byDate.keys()).sort().map((ymd) => {
    const first = byDate.get(ymd)[0];
    const lbl = formatTWDate(first.start_at);
    return { date: ymd, wd: (lbl.match(/（([^）]+)）/) || [])[1] || '', dd: ymd.slice(8) };
  }), [byDate]);

  useEffect(() => {
    if (days.length && !days.some((d) => d.date === activeDate)) setActiveDate(days[0].date);
  }, [days, activeDate]);

  const selectedSlot = selectedId ? slotById.get(selectedId) : null;

  function pick(id) {
    // 單選：點同一個取消、點別的覆蓋。
    setSelectedId((prev) => (prev === id ? null : id));
  }

  const bandGroups = useMemo(() => {
    const list = byDate.get(activeDate) || [];
    return BANDS.map((band) => ({ band, slots: list.filter((s) => band.test(slotHour(s))) }))
      .filter((g) => g.slots.length > 0);
  }, [byDate, activeDate]);

  // 首次預約提示（模組 1）：後端回 needs_booking_notice=true 才擋。
  // 刻意不靠 localStorage —— 換裝置/清快取就會漏跳，而且我們要的是「這個課期確認過」，
  // 那是伺服器端的事實。ack 成功才放行；ack 失敗絕不可當成已確認。
  async function ackNotice() {
    if (busy) return;
    setBusy(true);
    try {
      await slotsApi.ackBookingNotice(periodId);
      setData((prev) => (prev ? { ...prev, needs_booking_notice: false } : prev));
    } catch (e) {
      // 不關彈窗、不改狀態、不預約：下次還是會擋，避免「以為確認了其實沒有」
      toast.error(e?.response?.data?.error || '確認失敗，請再試一次');
      setBusy(false);
      return;
    }
    setBusy(false);
    // 按鈕寫的是「我已確認，繼續預約」，就必須真的繼續。
    // 這裡若只關窗結束，每個課期的第一次預約都會靜默失敗——沒有成功也沒有失敗
    // 提示，家長會以為約好了。不能回頭呼叫 submit()：它讀到的 data 還是同一個
    // render 的舊值，needs_booking_notice 仍是 true，會再把提示彈窗打開一次。
    await doBook();
  }

  // 真正送出預約。submit()（不需提示時）與 ackNotice()（提示確認後）共用同一段，
  // 確保兩條路徑的成功／失敗處理完全一致。
  async function doBook() {
    setBusy(true);
    try {
      await slotsApi.book(selectedId, periodId);
      setBusy(false);
      setConfirmOpen(false);
      setNoticeOpen(false);
      // 政策 2026-07：團班預約也即時成立（不再等待同組確認），任一家長預約即整組生效。
      toast.success(isGroup ? '已預約 1 堂（同組成員的課表將同步更新）' : '已預約 1 堂');
      if (onBooked) onBooked();
    } catch (e) {
      setBusy(false);
      setConfirmOpen(false);
      setNoticeOpen(false);
      toast.error(e?.response?.data?.error || '預約失敗，請改選其他時段');
      load();
    }
  }

  async function submit() {
    if (!selectedId || busy) return;
    // 只有自動產生的時段需要先確認（venue 由預約時認領，教練不一定知道這個時間）。
    // 教練手建的時段是教練自己排的，不必多這一道。
    const slot = slotById.get(selectedId);
    // 嚴格判斷：只有後端明確標記 is_auto === true 的時段才需要先確認。
    // 不可用 `!== false`——欄位缺失時會誤攔教練手建的時段。
    if (data?.needs_booking_notice && slot?.status === 'available' && slot?.is_auto === true) {
      setConfirmOpen(false);
      setNoticeOpen(true);
      return;
    }
    await doBook();
  }

  if (error) {
    return (
      <div className={embedded ? 'p-3' : 'px-4 py-6'}>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">{error}</div>
        <button type="button" onClick={load} className="mt-4 w-full rounded-lg bg-brand-primary py-3 text-sm font-bold text-white">重新載入</button>
      </div>
    );
  }
  if (!data) return <LoadingSpinner fullPage={!embedded} label="載入可預約時段…" />;

  // 資訊卡（教練/課程）：僅獨立頁顯示。
  const infoCard = (
    <div className="px-4 pt-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-brand-primary/10 px-2 py-0.5 text-xs font-semibold text-brand-primary">
            {courseTypeLabel(period.course_type)}
          </span>
          <span className="rounded-md bg-brand-green/15 px-2 py-0.5 text-xs font-semibold text-brand-green">
            尚可預約 {quota} 堂
          </span>
        </div>
        <div className="mt-2 text-lg font-bold text-gray-900">{period.coach_name || '教練'} · {period.venue_name || period.venue_id}</div>
        {isGroup && (
          <div className="mt-1.5 flex items-start gap-1.5 text-sm text-gray-500">
            <InfoIcon className="mt-0.5 shrink-0 text-gray-400" />
            <span>團班時段預約後立即成立，同組成員共用堂數並同步顯示於各自課表。</span>
          </div>
        )}
      </div>
    </div>
  );

  if (quota <= 0) {
    return <div className={embedded ? '' : 'pb-6'}>{!embedded && infoCard}<div className={embedded ? 'p-3' : 'px-4 pt-4'}><EmptyBlock text="此課程期可預約堂數已用完" /></div></div>;
  }
  if (days.length === 0) {
    return <div className={embedded ? '' : 'pb-6'}>{!embedded && infoCard}<div className={embedded ? 'p-3' : 'px-4 pt-4'}><EmptyBlock text="目前教練尚未開放可上課時間，請靜候教練更新可上課時間。" /></div></div>;
  }

  return (
    <div className={embedded ? '' : 'flex min-h-[calc(100dvh-3rem)] flex-col'}>
      {!embedded && infoCard}

      {embedded && isGroup && (
        <div className="px-3 pt-2 text-[11px] text-gray-400">團班時段預約後立即成立，同組成員共用堂數並同步顯示。</div>
      )}

      {/* 日期列 */}
      <div className={embedded ? 'px-3 pt-2' : 'sticky top-0 z-10 mt-4 border-b border-gray-100 bg-white px-4 py-3'}>
        <div className="flex gap-2 overflow-x-auto">
          {days.map((d) => (
            <DayChip key={d.date} d={d} active={d.date === activeDate}
              count={selectedSlot && formatTWYMD(selectedSlot.start_at) === d.date ? 1 : 0}
              onClick={() => setActiveDate(d.date)} />
          ))}
        </div>
      </div>

      {/* 時段（依早/午/晚分段、水平捲動） */}
      <div className={embedded ? 'space-y-4 px-3 py-3' : 'flex-1 space-y-5 px-4 py-4'}>
        {bandGroups.length === 0 ? (
          <EmptyBlock text="這天教練尚未開放時段，請改選其他日期。" />
        ) : (
          bandGroups.map(({ band, slots }) => (
            <Band key={band.key} band={band} slots={slots} compact={embedded} isSel={(id) => selectedId === id} onToggle={pick} />
          ))
        )}
      </div>

      {/* 送出列 */}
      <div className={embedded ? 'px-3 pb-3' : 'sticky bottom-0 z-10 border-t border-gray-100 bg-white px-4 py-3'}>
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500">
            已選 <span className="font-bold text-brand-primary">{selectedId ? 1 : 0}</span> 堂・尚可選 {Math.max(0, quota - (selectedId ? 1 : 0))} 堂
          </div>
          <button
            type="button"
            disabled={!selectedId || busy}
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
        confirmLabel="確認預約 1 堂"
        busy={busy}
        onCancel={() => { if (!busy) setConfirmOpen(false); }}
        onConfirm={submit}
      >
        <div className="space-y-2">
          {isGroup && <p className="text-xs text-gray-500">團班時段預約後立即成立，同組成員共用堂數並同步顯示。</p>}
          {selectedSlot && (
            <div className="rounded-lg bg-gray-50 px-3 py-2">
              <div className="text-xs font-bold text-brand-primary">{formatTWDate(selectedSlot.start_at)}</div>
              <div className="mt-1">
                <span className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs tabular-nums text-gray-700">
                  {formatTWTime(selectedSlot.start_at)}
                </span>
              </div>
            </div>
          )}
        </div>
      </ConfirmModal>

      {/* 首次預約提示（模組 1）：每個課期跳一次，確認寫入伺服器後才放行 */}
      <ConfirmModal
        open={noticeOpen}
        title="預約前請先與教練確認"
        confirmLabel="我已確認，繼續預約"
        cancelLabel="先不預約"
        busy={busy}
        onCancel={() => { if (!busy) setNoticeOpen(false); }}
        onConfirm={ackNotice}
      >
        <div className="space-y-2 text-sm text-gray-700">
          <p>系統顯示的時段是依場館營業時間自動開放的，<b>教練不一定已排定該時段</b>。</p>
          <p>請先與教練確認時間可行，再進行預約，避免到場後無法上課。</p>
          <p className="text-xs text-gray-500">此提示每個課程只會出現一次。</p>
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

function Band({ band, slots, compact, isSel, onToggle }) {
  const t = TONE[band.tone];
  // compact（內嵌於上課記錄頁）：移除「早上/下午/晚上 + 可預約 N」標頭與左側色條，去除贅字、畫面更乾淨。
  return (
    <section className={compact ? '' : `border-l-4 ${t.rail} pl-3`}>
      {!compact && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={`grid h-8 w-8 place-items-center rounded-full text-base ${t.iconBg}`}>{band.emoji}</div>
            <div className="text-sm font-semibold text-gray-900">{band.label}</div>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.chipBg} ${t.chipText}`}>可預約 {slots.length}</span>
        </div>
      )}
      <div className={`${compact ? '' : 'mt-3'} flex gap-2 overflow-x-auto pb-1`}>
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
