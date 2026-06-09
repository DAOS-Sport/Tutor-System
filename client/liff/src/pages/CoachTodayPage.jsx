import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionsApi } from '../api/sessions';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { courseTypeLabel, formatTWDate, formatTWTime, formatTWYMD, todayTaipeiYMD } from '../utils/format';

export default function CoachTodayPage() {
  const { coach } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [sessions, setSessions] = useState(null);
  // 其他（非今日）可代簽課程：讓教練不必只在「上課當天」才能代簽，過去/未來的已確認課程都進得去。
  const [otherSessions, setOtherSessions] = useState(null);

  useEffect(() => {
    if (!coach?.id) return;
    let alive = true;
    sessionsApi.todayByCoach(coach.id)
      .then((d) => alive && setSessions(d || []))
      .catch(() => { if (alive) { setSessions([]); toast.error('今日課程載入失敗'); } });

    // 取近 7 天～未來 60 天的課程，挑出「已確認/已完成」且非今日者供代簽入口。
    const from = new Date(Date.now() - 7 * 86400000).toISOString();
    const to = new Date(Date.now() + 60 * 86400000).toISOString();
    sessionsApi.weekByCoach(coach.id, { from, to })
      .then((d) => {
        if (!alive) return;
        const today = todayTaipeiYMD();
        setOtherSessions((d || []).filter((s) =>
          ['confirmed', 'completed'].includes(s.status) && formatTWYMD(s.scheduled_at) !== today));
      })
      .catch(() => alive && setOtherSessions([]));
    return () => { alive = false; };
  }, [coach?.id, toast]);

  if (!coach) return null;
  const todayLabel = formatTWDate(new Date());

  return (
    <div className="px-4 py-4">
      <section className="mb-5 rounded-2xl bg-gradient-to-br from-brand-primary to-brand-teal p-4 text-white shadow-md">
        <p className="text-xs opacity-90">{coach.name} 教練</p>
        <h2 className="mt-1 text-lg font-bold">今日：{todayLabel}</h2>
        <p className="mt-1 text-xs opacity-80">{coach.is_senior ? '資深教練' : '一般教練'} · 倍率 ×{coach.pricing_multiplier || coach.multiplier || 1}</p>
      </section>

      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold text-brand-primary">今日課程</h3>
          <span className="text-xs text-gray-500">共 {sessions?.length ?? '…'} 場</span>
        </div>

        {sessions === null && <LoadingSpinner label="載入中…" />}
        {sessions !== null && sessions.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
            今日沒有課程，去排課總表看看本週狀況吧。
          </div>
        )}
        {sessions && sessions.length > 0 && (
          <div className="space-y-2">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => navigate(`/coach/session/${s.id}`)}
                className="w-full rounded-xl border border-brand-primary/15 bg-white p-3 text-left shadow-sm active:bg-brand-primary/5"
              >
                <div className="flex items-baseline justify-between">
                  <div className="text-base font-bold text-brand-primary">
                    {formatTWTime(s.scheduled_at)}
                  </div>
                  <span className="rounded-full bg-brand-teal/10 px-2 py-0.5 text-[10px] text-brand-teal">
                    {courseTypeLabel(s.course_type)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-gray-500">{s.venue_name || s.venue_id}</div>
                {s.original_coach_name && (
                  <div className="mt-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                    原授課教練：{s.original_coach_name}
                  </div>
                )}
                <div className="mt-1 text-sm text-gray-800">
                  學員：{(s.student_names || []).join('、') || '—'}
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 ${s.checked_in ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                    {s.checked_in ? '已簽到' : '未簽到'}
                  </span>
                  <span className="text-brand-teal">點選進入授課 →</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {otherSessions && otherSessions.length > 0 && (
        <section className="mb-5">
          <h3 className="mb-2 text-sm font-bold text-brand-primary">其他課程（可代簽）</h3>
          <div className="space-y-2">
            {otherSessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => navigate(`/coach/session/${s.id}`)}
                className="w-full rounded-xl border border-brand-primary/15 bg-white p-3 text-left shadow-sm active:bg-brand-primary/5"
              >
                <div className="flex items-baseline justify-between">
                  <div className="text-sm font-bold text-brand-primary">
                    {formatTWDate(s.scheduled_at)} {formatTWTime(s.scheduled_at)}
                  </div>
                  <span className="rounded-full bg-brand-teal/10 px-2 py-0.5 text-[10px] text-brand-teal">
                    {courseTypeLabel(s.course_type)}
                  </span>
                </div>
                <div className="mt-1 text-sm text-gray-800">
                  學員：{(s.student_names || []).join('、') || '—'}
                </div>
                <div className="mt-1.5 text-xs text-brand-teal">點選進入代簽 →</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 gap-2">
        <button onClick={() => navigate('/coach/schedule')}
          className="rounded-xl border border-brand-primary/20 bg-white py-3 text-sm font-bold text-brand-primary active:bg-brand-primary/5">
          排課總表
        </button>
        <button onClick={() => navigate('/coach/profile')}
          className="rounded-xl border border-brand-primary/20 bg-white py-3 text-sm font-bold text-brand-primary active:bg-brand-primary/5">
          個人介紹
        </button>
      </section>
    </div>
  );
}
