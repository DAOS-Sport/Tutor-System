import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionsApi } from '../api/sessions';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { courseTypeLabel } from '../utils/format';

/**
 * 教練端：學員管理（MVP）
 * - 從本週課程聚合「教過 / 即將教」的學員清單
 * - 顯示：學員名、上課場次數、最近一次課程時間/場館
 * - 點擊 → 進入該學員下一場課程的授課入口（Phase 5 將擴成完整學習歷程頁）
 */
function startOfWeek(d) { const x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - x.getDay()); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export default function CoachStudentsPage() {
  const { coach } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [sessions, setSessions] = useState(null);

  useEffect(() => {
    if (!coach?.id) return;
    let alive = true;
    const from = startOfWeek(new Date()).toISOString();
    const to = addDays(startOfWeek(new Date()), 14).toISOString();
    sessionsApi.weekByCoach(coach.id, { from, to })
      .then((d) => alive && setSessions(d || []))
      .catch(() => { if (alive) { setSessions([]); toast.error('學員清單載入失敗'); } });
    return () => { alive = false; };
  }, [coach?.id, toast]);

  const students = useMemo(() => {
    const map = new Map(); // name → { name, count, latest }
    for (const s of sessions || []) {
      for (const name of (s.student_names || [])) {
        const cur = map.get(name) || { name, count: 0, latest: null };
        cur.count += 1;
        if (!cur.latest || new Date(s.scheduled_at) > new Date(cur.latest.scheduled_at)) {
          cur.latest = s;
        }
        map.set(name, cur);
      }
    }
    return [...map.values()].sort((a, b) =>
      new Date(a.latest?.scheduled_at || 0) - new Date(b.latest?.scheduled_at || 0)
    );
  }, [sessions]);

  if (!coach) return null;

  return (
    <div className="px-4 py-4">
      <header className="mb-4">
        <h1 className="text-base font-bold text-brand-primary">學員管理</h1>
        <p className="mt-0.5 text-xs text-gray-500">本週與下週授課學員（共 {students.length} 位）</p>
      </header>

      {sessions === null && <LoadingSpinner label="載入中…" />}
      {sessions !== null && students.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
          近兩週尚無學員課程
        </div>
      )}
      {students.length > 0 && (
        <ul className="space-y-2">
          {students.map((st) => (
            <li key={st.name}>
              <button
                type="button"
                onClick={() => st.latest && navigate(`/coach/session/${st.latest.id}`)}
                className="w-full rounded-xl border border-brand-primary/15 bg-white p-3 text-left shadow-sm active:bg-brand-primary/5"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-bold text-brand-primary">{st.name}</span>
                  <span className="rounded-full bg-brand-teal/10 px-2 py-0.5 text-[10px] text-brand-teal">{st.count} 場</span>
                </div>
                {st.latest && (
                  <div className="mt-1 text-xs text-gray-500">
                    最近：{fmtDateTime(st.latest.scheduled_at)} · {st.latest.venue_name || st.latest.venue_id} · {courseTypeLabel(st.latest.course_type)}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-center text-[11px] text-gray-400">
        完整學習歷程 / 上課記錄將於 Phase 5 開放
      </p>
    </div>
  );
}
