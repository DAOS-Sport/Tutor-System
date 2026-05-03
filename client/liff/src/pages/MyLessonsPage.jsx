import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { lessonsApi } from '../api/lessons';

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

export default function MyLessonsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [range, setRange] = useState('all');
  const [coachId, setCoachId] = useState('');
  const [courseType, setCourseType] = useState('');

  useEffect(() => {
    setData(null);
    const params = {};
    const cfg = RANGES.find((r) => r.key === range);
    if (cfg?.days) {
      const d = new Date(); d.setDate(d.getDate() - cfg.days);
      params.from = d.toISOString().slice(0, 10);
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
      const key = new Date(r.scheduled_at).toISOString().slice(0, 7);
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
                  onOpen={() => r.record_id && navigate(`/history/${r.period_id}`)} />)}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function LessonCard({ r, onOpen }) {
  const cls = classify(r);
  const date = new Date(r.scheduled_at);
  const dStr = date.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit', weekday: 'short' });
  const tStr = date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <button type="button" onClick={onOpen}
      className="block w-full rounded-xl border border-gray-200 bg-white p-3 text-left active:bg-gray-50">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-brand-primary">{dStr} {tStr}</div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
          cls === 'attended' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
        }`}>{cls === 'attended' ? '已出席' : '即將上課'}</span>
      </div>
      <div className="mt-1 text-xs text-gray-600">
        {r.coach_name} 教練・1對{r.course_type}・{r.venue_id} 館
      </div>
      <div className="mt-0.5 text-xs text-gray-500">
        學員：{r.student_name}
        {r.checked_in_at && <span className="ml-2">・簽到於 {new Date(r.checked_in_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>}
      </div>
      {r.record_id && (
        <div className="mt-1.5 text-[11px] font-medium text-brand-teal">
          📝 教練已上傳上課記錄 · 點擊查看 ›
        </div>
      )}
    </button>
  );
}
