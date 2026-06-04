import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { sessionsApi } from '../api/sessions';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { courseTypeLabel, formatTWDate } from '../utils/format';

/**
 * 授課入口頁（F-C04 / F-C05 入口）
 * MVP 階段：顯示課程詳情 + 簽到狀態 + 「填授課記錄」CTA（Phase 5 接續開發實際表單）
 */
function fmtTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export default function CoachSessionPage() {
  const { id } = useParams();
  const { coach } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!coach?.id || !id) return;
    let alive = true;
    sessionsApi.detail(id)
      .then((d) => alive && setSession(d))
      .catch((err) => {
        if (!alive) return;
        const status = err?.response?.status;
        setError(status === 403 ? '此課程不屬於您' : status === 404 ? '查無此課程' : '載入失敗');
      });
    return () => { alive = false; };
  }, [coach?.id, id]);

  if (!coach) return null;
  if (error) {
    return (
      <div className="px-4 py-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">{error}</div>
        <button onClick={() => navigate(-1)} className="mt-4 w-full rounded-lg bg-brand-primary py-3 text-sm font-bold text-white">返回</button>
      </div>
    );
  }
  if (!session) return <div className="px-4 py-6"><LoadingSpinner label="載入中…" /></div>;

  return (
    <div className="px-4 py-4">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-brand-teal active:opacity-60">‹ 返回今日課程</button>

      <section className="rounded-2xl bg-gradient-to-br from-brand-primary to-brand-teal p-4 text-white shadow-md">
        <p className="text-xs opacity-90">{formatTWDate(new Date(session.scheduled_at))}</p>
        <h1 className="mt-1 text-2xl font-bold">{fmtTime(session.scheduled_at)}</h1>
        <p className="mt-1 text-xs opacity-90">{session.venue_name} · {courseTypeLabel(session.course_type)} · {session.duration_minutes} 分鐘</p>
      </section>

      <section className="mt-4 rounded-xl border border-brand-primary/15 bg-white p-4">
        <h2 className="text-xs font-bold text-brand-primary">學員</h2>
        <p className="mt-1 text-sm text-gray-800">{(session.student_names || []).join('、') || '—'}</p>
      </section>

      <section className="mt-3 rounded-xl border border-brand-primary/15 bg-white p-4">
        <h2 className="text-xs font-bold text-brand-primary">狀態</h2>
        <p className="mt-1 text-sm text-gray-800">{session.status}</p>
      </section>

      <section className="mt-5 space-y-2">
        <button
          type="button"
          disabled
          className="w-full rounded-xl bg-gray-200 py-3 text-sm font-bold text-gray-400 cursor-not-allowed"
        >
          簽到功能開發中
        </button>
        {session.course_period_id && (
          <button
            type="button"
            onClick={() => navigate(`/coach/plan/${session.course_period_id}`)}
            className="w-full rounded-xl border border-brand-primary/30 bg-white py-3 text-sm font-bold text-brand-primary active:bg-brand-primary/5"
          >
            填寫課前規劃
          </button>
        )}
        <button
          type="button"
          onClick={() => navigate(`/coach/record/${id}`)}
          className="w-full rounded-xl bg-brand-primary py-3 text-sm font-bold text-white active:opacity-90"
        >
          填寫授課記錄
        </button>
      </section>
    </div>
  );
}
