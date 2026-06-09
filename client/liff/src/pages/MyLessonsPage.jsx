import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { lessonsApi } from '../api/lessons';
import { checkinsApi } from '../api/checkins';
import { addDaysToTaipeiYMD, formatTWDate, formatTWMonthKey, formatTWTime, formatTWYMD, todayTaipeiYMD } from '../utils/format';

const FILTERS = [
  { key: 'all',         label: '全部' },
  { key: 'attended',    label: '已出席' },
  { key: 'upcoming',    label: '即將上課' },
];

const RANGES = [
  { key: 'all', label: '全部時間', days: null },
  { key: '30',  label: '近 30 天',  days: 30 },
  { key: '90',  label: '近 90 天',  days: 90 },
  { key: '365', label: '近一年',    days: 365 },
];

function classify(r) {
  if (r.checkin_id) return 'attended';
  const t = new Date(r.scheduled_at).getTime();
  return t > Date.now() ? 'upcoming' : 'attended';
}

// 家長可自助簽到的條件：尚未簽到、課程已確認/完成、且是今天（台北時區）的課。
// 與後端 POST /api/checkins 的狀態守門一致；今日限制避免家長對未來課程提前簽到。
function canParentCheckin(r) {
  return !r.checkin_id
    && ['confirmed', 'completed'].includes(r.session_status)
    && formatTWYMD(r.scheduled_at) === todayTaipeiYMD();
}

export default function MyLessonsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [range, setRange] = useState('all');
  const [coachId, setCoachId] = useState('');
  const [courseType, setCourseType] = useState('');
  const [checkinBusyKey, setCheckinBusyKey] = useState(null);

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
    } catch (err) {
      toast.error(err?.response?.data?.error || '簽到失敗');
    } finally {
      setCheckinBusyKey(null);
    }
  }

  useEffect(() => {
    setData(null);
    const params = {};
    const cfg = RANGES.find((r) => r.key === range);
    if (cfg?.days) {
      params.from = addDaysToTaipeiYMD(todayTaipeiYMD(), -cfg.days);
    }
    if (coachId) params.coachId = coachId;
    if (courseType) params.courseType = courseType;
    lessonsApi.mine(params)
      .then(setData)
      .catch(() => { setData([]); toast.error('上課記錄載入失敗'); });
  }, [toast, range, coachId, courseType]);

  // 教練 / 組別 選項由結果動態彙總（避免額外 API）
  const coachOptions = useMemo(() => {
    const m = new Map();
    (data || []).forEach((r) => { if (r.coach_id) m.set(r.coach_id, r.coach_name); });
    return Array.from(m.entries()).map(([id, name]) => ({ id, name }));
  }, [data]);
  const typeOptions = useMemo(() => {
    const s = new Set(); (data || []).forEach((r) => r.course_type && s.add(r.course_type));
    return Array.from(s);
  }, [data]);

  const grouped = useMemo(() => {
    const list = (data || []).filter((r) => filter === 'all' || classify(r) === filter);
    const m = new Map();
    for (const r of list) {
      const key = formatTWMonthKey(r.scheduled_at);
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    }
    return Array.from(m.entries());
  }, [data, filter]);

  const counts = useMemo(() => {
    const c = { all: 0, attended: 0, upcoming: 0 };
    (data || []).forEach((r) => { c.all += 1; c[classify(r)] += 1; });
    return c;
  }, [data]);

  return (
    <div className="px-4 py-4">
      <h1 className="mb-3 text-base font-bold text-brand-primary">上課記錄</h1>

      <div className="mb-2 flex gap-2 overflow-x-auto">
        {RANGES.map((r) => (
          <button key={r.key} type="button" onClick={() => setRange(r.key)}
            className={`shrink-0 rounded-full border px-3 py-1 text-[11px] ${
              range === r.key ? 'border-brand-teal bg-brand-teal text-white' : 'border-gray-200 bg-white text-gray-600'
            }`}>{r.label}</button>
        ))}
      </div>

      <div className="mb-3 flex gap-2">
        <select value={coachId} onChange={(e) => setCoachId(e.target.value)}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs">
          <option value="">全部教練</option>
          {coachOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={courseType} onChange={(e) => setCourseType(e.target.value)}
          className="flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs">
          <option value="">全部組別</option>
          {typeOptions.map((t) => <option key={t} value={t}>1對{t}</option>)}
        </select>
      </div>

      <div className="mb-3 flex gap-2">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${
              filter === f.key
                ? 'border-brand-primary bg-brand-primary text-white'
                : 'border-gray-200 bg-white text-gray-600'
            }`}>
            {f.label}（{counts[f.key]}）
          </button>
        ))}
      </div>

      {data === null ? <LoadingSpinner label="載入中…" /> : grouped.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          沒有符合條件的上課記錄
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([month, rows]) => (
            <section key={month}>
              <h3 className="mb-1.5 text-xs font-bold text-brand-primary">{month.replace('-', ' / ')}</h3>
              <div className="space-y-2">
                {rows.map((r) => <LessonCard key={r.session_id + r.student_id} r={r}
                  onOpen={() => r.record_status === 'submitted' && navigate(`/history/${r.period_id}`)}
                  onCheckin={() => handleCheckin(r)}
                  busy={checkinBusyKey === (r.session_id + r.student_id)} />)}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function LessonCard({ r, onOpen, onCheckin, busy }) {
  const checkinable = canParentCheckin(r);
  const cls = classify(r);
  const dStr = formatTWDate(r.scheduled_at);
  const tStr = formatTWTime(r.scheduled_at);
  const clickable = r.record_status === 'submitted';
  const badge = checkinable
    ? { text: '可簽到', cls: 'bg-brand-teal/15 text-brand-teal' }
    : cls === 'attended'
      ? { text: '已出席', cls: 'bg-green-100 text-green-700' }
      : { text: '即將上課', cls: 'bg-amber-100 text-amber-700' };
  return (
    <div onClick={clickable ? onOpen : undefined}
      className={`block w-full rounded-xl border border-gray-200 bg-white p-3 text-left ${clickable ? 'cursor-pointer active:bg-gray-50' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-brand-primary">{dStr} {tStr}</div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badge.cls}`}>{badge.text}</span>
      </div>
      <div className="mt-1 text-xs text-gray-600">
        {r.coach_name} 教練・1對{r.course_type}・{r.venue_id} 館
      </div>
      <div className="mt-0.5 text-xs text-gray-500">
        學員：{r.student_name}
        {r.checked_in_at && <span className="ml-2">・簽到於 {formatTWTime(r.checked_in_at)}</span>}
      </div>
      {r.record_status === 'submitted' && (
        <div className="mt-1.5 text-[11px] font-medium text-brand-teal">
          📝 教練已上傳上課記錄 · 點擊查看 ›
        </div>
      )}
      {checkinable && (
        <button
          type="button"
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); onCheckin(); }}
          className="mt-2 w-full rounded-lg bg-brand-primary py-2 text-xs font-bold text-white active:opacity-90 disabled:bg-gray-300"
        >
          {busy ? '簽到中…' : '我要簽到'}
        </button>
      )}
    </div>
  );
}
