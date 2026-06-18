import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import { lessonsApi } from '../api/lessons';
import { checkinsApi } from '../api/checkins';
import { courseTypeLabel, formatTWDate, formatTWDateTime, formatTWTime } from '../utils/format';

// 家長可自助簽到：尚未簽到、且課程已確認/完成（不限上課當天，隨時可補簽）。
function canParentCheckin(r) {
  return !r.checked_in_at && ['confirmed', 'completed'].includes(r.session_status);
}

// 由開始時間 + 時長算出「HH:MM–HH:MM」時段字串。
function timeRange(r) {
  const start = new Date(r.scheduled_at);
  if (Number.isNaN(start.getTime())) return '';
  const dur = Number(r.duration_minutes) || 60;
  const end = new Date(start.getTime() + dur * 60000);
  return `${formatTWTime(start)}–${formatTWTime(end)}`;
}

export default function MyLessonsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [enrollId, setEnrollId] = useState('');
  const [open, setOpen] = useState(false);
  const [checkinBusyKey, setCheckinBusyKey] = useState(null);
  // 點「簽到」先跳確認視窗：confirmRow 為待確認的那筆，確認後才真正送出。
  const [confirmRow, setConfirmRow] = useState(null);

  useEffect(() => {
    lessonsApi.mine({})
      .then((d) => setData(Array.isArray(d) ? d : []))
      .catch(() => { setData([]); toast.error('上課記錄載入失敗'); });
  }, [toast]);

  async function handleCheckin(r) {
    const key = r.session_id + r.student_id;
    if (checkinBusyKey) return;
    setCheckinBusyKey(key);
    try {
      const res = await checkinsApi.create({ sessionId: r.session_id, studentId: r.student_id });
      setData((prev) => (prev || []).map((row) => (
        row.session_id === r.session_id && row.student_id === r.student_id
          ? { ...row, checkin_id: res.checkin_id, checked_in_at: res.checked_in_at }
          : row
      )));
      toast.success(`${r.student_name} 已簽到`);
      setConfirmRow(null);
    } catch (err) {
      toast.error(err?.response?.data?.error || '簽到失敗');
    } finally {
      setCheckinBusyKey(null);
    }
  }

  // 扁平的上課記錄 → 依「課程期 × 學員」彙整成一筆筆「報名（課程包）」。
  const enrollments = useMemo(() => {
    const m = new Map();
    for (const r of data || []) {
      const key = `${r.period_id}|${r.student_id}`;
      if (!m.has(key)) {
        const total = Number(r.total_sessions) || 0;
        const used = Number(r.used_sessions) || 0;
        m.set(key, {
          id: key,
          coach: r.coach_name,
          group: courseTypeLabel(r.course_type),
          pct: Math.round((Number(r.pricing_multiplier) || 1) * 100),
          student: r.student_name,
          total,
          remain: Math.max(0, total - used),
          records: [],
        });
      }
      m.get(key).records.push(r);
    }
    return Array.from(m.values());
  }, [data]);

  // 預設選第一筆；資料變動後若目前選的不存在則重設。
  useEffect(() => {
    if (enrollments.length && !enrollments.some((e) => e.id === enrollId)) {
      setEnrollId(enrollments[0].id);
    }
  }, [enrollments, enrollId]);

  const enrollment = enrollments.find((e) => e.id === enrollId) || null;

  // 上課明細排序：即將上課（未來）由近到遠在前；已出席（過去）由新到舊在後。
  const sorted = useMemo(() => {
    if (!enrollment) return [];
    const now = Date.now();
    return [...enrollment.records].sort((a, b) => {
      const da = new Date(a.scheduled_at).getTime() - now;
      const db = new Date(b.scheduled_at).getTime() - now;
      const fa = da >= 0;
      const fb = db >= 0;
      if (fa && fb) return da - db;
      if (!fa && !fb) return db - da;
      return fa ? -1 : 1;
    });
  }, [enrollment]);

  if (data === null) return <LoadingSpinner label="載入中…" />;

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-gray-50">
      {enrollments.length === 0 ? (
        <div className="px-4 py-4">
          <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            沒有符合條件的上課記錄
          </div>
        </div>
      ) : (
        <>
          {/* 課程包選擇器：下拉切換不同報名，拉開即可看到每包剩餘堂數 */}
          <div className="bg-white px-4 pb-4 pt-4">
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="flex w-full items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left shadow-sm active:bg-gray-50"
              >
                <EnrollmentLines e={enrollment} />
                <RemainBlock n={enrollment.remain} />
                <ChevronDownIcon className={`shrink-0 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
              </button>

              {open && (
                // 多筆報名時，一筆與一筆之間留約兩行（11px）的間距，較好辨識差異。
                <div className="absolute left-0 right-0 top-full z-50 mt-2 flex flex-col gap-5 rounded-2xl border border-gray-100 bg-white p-2 shadow-xl">
                  {enrollments.map((e) => {
                    const sel = e.id === enrollId;
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => { setEnrollId(e.id); setOpen(false); }}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left ${sel ? 'bg-gray-50' : 'active:bg-gray-50'}`}
                      >
                        <span className="w-5 shrink-0">{sel && <CheckIcon className="text-brand-primary" />}</span>
                        <EnrollmentLines e={e} compact />
                        <RemainBlock n={e.remain} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 上課明細 */}
          <div className="px-4 pb-6 pt-1">
            <div className="mb-2 px-1 text-xs text-gray-400">上課明細 · 共 {sorted.length} 筆</div>
            {sorted.length > 0 ? (
              <div className="space-y-2.5">
                {sorted.map((r) => (
                  <RecordCard
                    key={r.session_id + r.student_id}
                    r={r}
                    e={enrollment}
                    busy={checkinBusyKey === (r.session_id + r.student_id)}
                    onCheckin={() => setConfirmRow(r)}
                    onOpen={() => r.record_status === 'submitted' && navigate(`/history/${r.period_id}`)}
                  />
                ))}
              </div>
            ) : (
              <div className="mt-2 rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-10 text-center text-sm text-gray-400">
                沒有符合條件的上課記錄
              </div>
            )}
          </div>

          {/* 點擊外部關閉下拉 */}
          {open && <button aria-label="關閉" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />}
        </>
      )}

      <ConfirmModal
        open={!!confirmRow}
        title="確認簽到"
        confirmLabel="確認簽到"
        busy={!!checkinBusyKey}
        onCancel={() => { if (!checkinBusyKey) setConfirmRow(null); }}
        onConfirm={() => confirmRow && handleCheckin(confirmRow)}
      >
        {confirmRow && (
          <>確定要為 <span className="font-bold text-brand-primary">{confirmRow.student_name}</span> 簽到嗎？簽到後將無法取消。</>
        )}
      </ConfirmModal>
    </div>
  );
}

// 右側大字剩餘堂數
function RemainBlock({ n }) {
  return (
    <div className="shrink-0 text-right">
      <div className="text-lg font-bold leading-none tabular-nums text-brand-primary">{n}</div>
      <div className="mt-0.5 text-xs text-gray-400">剩餘堂</div>
    </div>
  );
}

// 兩行：{教練}_{組別} ({修課係數%}) ／ {學員} · 共 N 堂
function EnrollmentLines({ e, compact }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-semibold text-brand-primary">
        {e.coach}_{e.group} <span className="font-medium text-gray-400">({e.pct}%)</span>
      </div>
      <div className={`truncate text-xs text-gray-500 ${compact ? 'mt-0.5' : 'mt-1'}`}>
        {e.student} · 共 {e.total} 堂
      </div>
    </div>
  );
}

function RecordCard({ r, e, busy, onCheckin, onOpen }) {
  const past = new Date(r.scheduled_at).getTime() < Date.now();
  const checkinable = canParentCheckin(r);
  const clickable = r.record_status === 'submitted';
  return (
    <div
      onClick={clickable ? onOpen : undefined}
      className={`rounded-2xl border border-gray-100 bg-white p-3.5 shadow-sm ${clickable ? 'cursor-pointer active:bg-gray-50' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold tabular-nums text-gray-900">
          {formatTWDate(r.scheduled_at).replace(/^\d{4}\//, '')}
        </div>
        {r.checked_in_at ? (
          <span className="rounded-full bg-brand-green/15 px-2.5 py-0.5 text-xs font-medium text-brand-green">已出席</span>
        ) : checkinable ? (
          <button
            type="button"
            disabled={busy}
            onClick={(ev) => { ev.stopPropagation(); onCheckin(); }}
            className="rounded-full bg-brand-primary px-3 py-0.5 text-xs font-bold text-white active:opacity-90 disabled:opacity-50"
          >
            {busy ? '簽到中…' : '簽到'}
          </button>
        ) : (
          <span className="rounded-full bg-brand-primary/10 px-2.5 py-0.5 text-xs font-medium text-brand-primary">
            {past ? '已出席' : '即將上課'}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 text-sm text-gray-500">
        <ClockIcon className="shrink-0 text-gray-400" />
        <span className="tabular-nums">{timeRange(r)}</span>
        <span className="text-gray-300">·</span>
        <span>{e.coach}　{e.group}</span>
      </div>
      {r.checked_in_at && (
        <div className="mt-1.5 text-[11px] font-medium text-brand-green">簽到於 {formatTWDateTime(r.checked_in_at)}</div>
      )}
      {clickable && (
        <div className="mt-1.5 text-[11px] font-medium text-brand-teal">📝 教練已上傳記錄 · 點擊查看 ›</div>
      )}
    </div>
  );
}

function ChevronDownIcon({ className = '' }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon({ className = '' }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function ClockIcon({ className = '' }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
