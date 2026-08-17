import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionsApi } from '../api/sessions';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { formatTWDate, formatTWTime, todayTaipeiYMD, addDaysToTaipeiYMD, checkinLabel } from '../utils/format';
import CoachRecordCard, {
  StatusBanner, TypeBadge, courseTitle, ratePercent, periodSummary,
} from '../components/coach/CoachRecordCard';

const STATUS_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'unchecked', label: '已預約未簽到' },
  { key: 'checked', label: '已預約已簽到' },
];

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

function periodLabel(p) {
  return (p.student_names || []).join('、') || '—';
}
function remainingText(p) {
  const total = Number(p.total_sessions) || 0;
  const used = Number(p.used_sessions) || 0;
  return `剩${Math.max(0, total - used)}/全${total}`;
}

export default function CoachHistoryPage() {
  const { coach } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [from, setFrom] = useState(() => addDaysToTaipeiYMD(todayTaipeiYMD(), -30));
  const [to, setTo] = useState(() => todayTaipeiYMD());
  const [status, setStatus] = useState('all');
  const [periodId, setPeriodId] = useState('');
  const [sessions, setSessions] = useState(null);
  const [periods, setPeriods] = useState(null);
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef(null);

  // 學員下拉：載入教練名下每一期課程
  useEffect(() => {
    if (!coach?.id) return;
    let alive = true;
    sessionsApi.historyPeriodsByCoach(coach.id)
      .then((d) => alive && setPeriods(d || []))
      .catch(() => { if (alive) setPeriods([]); });
    return () => { alive = false; };
  }, [coach?.id]);

  // 場次清單：任一篩選條件變動即重查（sessions 先設 null 顯示載入中）
  useEffect(() => {
    if (!coach?.id) return;
    let alive = true;
    setSessions(null);
    sessionsApi.historyByCoach(coach.id, { from, to, status, periodId: periodId || undefined })
      .then((d) => alive && setSessions(d || []))
      .catch(() => { if (alive) { setSessions([]); toast.error('授課記錄載入失敗'); } });
    return () => { alive = false; };
  }, [coach?.id, from, to, status, periodId, toast]);

  // 點下拉面板外面即關閉
  useEffect(() => {
    if (!dropOpen) return;
    function onDocClick(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) setDropOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [dropOpen]);

  if (!coach) return null;

  const selectedPeriod = periodId ? (periods || []).find((p) => p.id === periodId) : null;
  const dropLabel = selectedPeriod ? periodLabel(selectedPeriod) : '全部學員';

  return (
    <div className="pb-4">
      <header className="sticky top-0 z-10 space-y-2 border-b border-gray-100 bg-white px-4 py-2.5">
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-bold text-brand-primary">授課記錄</h1>
          <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-500">
            {sessions === null ? '載入中…' : `共 ${sessions.length} 筆`}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="block w-full min-w-0 box-border appearance-none rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="block w-full min-w-0 box-border appearance-none rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_OPTIONS.map((o) => (
            <FilterChip key={o.key} active={status === o.key} onClick={() => setStatus(o.key)}>
              {o.label}
            </FilterChip>
          ))}
        </div>
        {/* 學員篩選：自製下拉，達成「姓名靠左、堂數靠右」對齊 */}
        <div className="relative" ref={dropRef}>
          <button
            type="button"
            onClick={() => setDropOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-lg border border-gray-300 px-3 py-2 text-sm active:bg-gray-50"
          >
            <span className="truncate text-gray-800">{dropLabel}</span>
            <span className="ml-2 shrink-0 text-gray-400">▾</span>
          </button>
          {dropOpen && (
            <div className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-brand-primary/15 bg-white shadow-lg">
              <button
                type="button"
                onClick={() => { setPeriodId(''); setDropOpen(false); }}
                className={`flex w-full items-center px-3 py-2 text-sm ${periodId === '' ? 'bg-brand-primary/5 text-brand-primary' : 'text-gray-700'}`}
              >
                全部學員
              </button>
              {(periods || []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setPeriodId(p.id); setDropOpen(false); }}
                  className={`flex w-full items-center justify-between gap-3 border-t border-gray-50 px-3 py-2 text-sm ${periodId === p.id ? 'bg-brand-primary/5' : ''}`}
                >
                  <span className="truncate text-left text-gray-800">{periodLabel(p)}</span>
                  <span className="shrink-0 text-xs text-gray-500">{remainingText(p)}</span>
                </button>
              ))}
              {periods !== null && periods.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-400">尚無課程資料</div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="px-4 pt-3">
        {sessions === null && <LoadingSpinner label="載入中…" />}
        {sessions !== null && sessions.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
            此區間沒有符合條件的授課記錄。
          </div>
        )}
        {sessions && sessions.length > 0 && (
          <div className="space-y-3">
            {sessions.map((s) => (
              <CoachRecordCard
                key={s.id}
                onClick={() => navigate(`/coach/session/${s.id}`)}
                title={courseTitle(coach?.name, s.course_type)}
                rate={ratePercent(coach?.multiplier ?? coach?.pricing_multiplier)}
                subject={
                  <>
                    <span>{(s.student_names || []).join('、') || '—'}</span>
                    {periodSummary(s.period_count, s.total_sessions) && (
                      <>
                        <span className="mx-1 text-gray-300">‧</span>
                        <span className="whitespace-nowrap text-gray-900">{periodSummary(s.period_count, s.total_sessions)}</span>
                      </>
                    )}
                  </>
                }
                meta={
                  <>
                    {formatTWDate(s.scheduled_at)} {formatTWTime(s.scheduled_at)}
                    <span className="mx-1">‧</span>
                    <span className="text-gray-500">{s.venue_name || s.venue_id}</span>
                    {/* 代課要留在卡片上：教練看到不是自己開的課會先愣一下，
                        沒有這行就得點進去才知道為什麼。 */}
                    {s.original_coach_name && (
                      <div className="mt-1 inline-block rounded-full bg-brand-amber/10 px-2 py-0.5 text-[10px] font-medium text-brand-amber">
                        原授課教練：{s.original_coach_name}
                      </div>
                    )}
                  </>
                }
                aside={
                  <>
                    <TypeBadge courseType={s.course_type} />
                    {/* 這裡只呈現「簽到記錄」，不做成看起來能按的按鈕。
                        簽到會扣課並推播給教練，有自己的流程與稽核，
                        不該讓人以為在列表上點一下就能改。
                        時分拆到第二行：checkinLabel 會回「已簽到 11:58」，
                        整串塞進 60px 寬會被截成「已簽到 1…」。 */}
                    {s.checked_in
                      ? <StatusBanner
                          tone="green"
                          label="已簽到"
                          sub={checkinLabel(s.scheduled_at, s.checked_in_at).replace('已簽到', '').trim() || null}
                        />
                      : <StatusBanner tone="gray" label="未簽到" />}
                  </>
                }
                footer={<span className="font-semibold text-brand-teal">點選進入 →</span>}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
