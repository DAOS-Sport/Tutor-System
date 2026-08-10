import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { sessionsApi } from '../api/sessions';
import { useAuth } from '../context/AuthContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { courseTypeLabel, formatTWDate, formatTWTime } from '../utils/format';

/**
 * 授課入口頁（F-C04 / F-C05 入口）
 * MVP 階段：顯示課程詳情 + 簽到狀態 + 「填授課記錄」CTA（Phase 5 接續開發實際表單）
 */
const SESSION_STATUS = {
  pending_group_confirm: {
    label: '等待同組家長確認',
    cls: 'bg-amber-100 text-amber-700',
    help: '同組家庭尚未全數確認此時段，暫不可簽到或填授課記錄。',
  },
  confirmed: {
    label: '已確認',
    cls: 'bg-green-100 text-green-700',
    help: '請家長於上課當日至系統完成簽到；教練端不提供代簽。',
  },
  completed: {
    label: '已完成',
    cls: 'bg-gray-100 text-gray-600',
    help: '課程已完成，仍可查看簽到狀態。',
  },
  cancelled_normal: {
    label: '已取消',
    cls: 'bg-gray-100 text-gray-500',
    help: '此課程已取消。',
  },
  cancelled_penalty: {
    label: '已取消',
    cls: 'bg-gray-100 text-gray-500',
    help: '此課程已取消。',
  },
};

// 簽到來源顯示。
// ⚠️ 'coach' 分支僅供歷史紀錄：教練代簽已於 2026-08-10 移除，系統不會再產生此來源，
//    但資料庫既有列仍是 'coach'。拿掉這個分支會把舊紀錄錯標成「家長簽到」。
function checkinSourceLabel(source) {
  return source === 'coach' ? '教練代簽（舊制）' : '家長簽到';
}

export default function CoachSessionPage() {
  const { id } = useParams();
  const { coach } = useAuth();
  const navigate = useNavigate();
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

  const statusMeta = SESSION_STATUS[session.status] || {
    label: session.status || '—',
    cls: 'bg-gray-100 text-gray-600',
    help: '',
  };
  const canRecord = ['confirmed', 'completed'].includes(session.status);
  const students = Array.isArray(session.students_detail) && session.students_detail.length
    ? session.students_detail
    : (session.student_names || []).map((name) => ({ name, checked_in: false }));

  return (
    <div className="px-4 py-4">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-brand-teal active:opacity-60">‹ 返回今日課程</button>

      <section className="rounded-2xl bg-gradient-to-br from-brand-primary to-brand-teal p-4 text-white shadow-md">
        <p className="text-xs opacity-90">{formatTWDate(session.scheduled_at)}</p>
        <h1 className="mt-1 text-2xl font-bold">{formatTWTime(session.scheduled_at)}</h1>
        <p className="mt-1 text-xs opacity-90">{session.venue_name} · {courseTypeLabel(session.course_type)} · {session.duration_minutes} 分鐘</p>
      </section>

      <section className="mt-4 rounded-xl border border-brand-primary/15 bg-white p-4">
        <h2 className="text-xs font-bold text-brand-primary">學員</h2>
        <p className="mt-1 text-sm text-gray-800">{students.map((s) => s.name).filter(Boolean).join('、') || '—'}</p>
      </section>

      <section className="mt-3 rounded-xl border border-brand-primary/15 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-bold text-brand-primary">狀態</h2>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${statusMeta.cls}`}>{statusMeta.label}</span>
        </div>
        {statusMeta.help && <p className="mt-2 text-xs leading-5 text-gray-500">{statusMeta.help}</p>}
      </section>

      <section className="mt-3 rounded-xl border border-brand-primary/15 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-bold text-brand-primary">簽到</h2>
          <span className="text-[11px] text-gray-400">
            {students.filter((s) => s.checked_in).length}/{students.length}
          </span>
        </div>
        <div className="space-y-2">
          {students.map((student) => (
            <div key={student.id || student.name} className="rounded-lg bg-gray-50 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-gray-800">{student.name || '學員'}</div>
                  {student.parent_name && <div className="mt-0.5 truncate text-[11px] text-gray-500">家長：{student.parent_name}</div>}
                  {student.checked_in && (
                    <div className="mt-0.5 text-[11px] text-brand-green">
                      已簽到 · {checkinSourceLabel(student.checked_in_source)}
                      {student.checked_in_at ? ` · ${formatTWTime(student.checked_in_at)}` : ''}
                    </div>
                  )}
                </div>
                {student.checked_in ? (
                  <span className="shrink-0 rounded-full bg-brand-green/15 px-2 py-1 text-[11px] font-bold text-brand-green">已簽</span>
                ) : (
                  <span className="shrink-0 rounded-full bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-400">未簽到</span>
                )}
              </div>
            </div>
          ))}
          {students.length === 0 && <div className="rounded-lg bg-gray-50 p-3 text-center text-xs text-gray-500">尚無學員名單</div>}
        </div>
      </section>

      <section className="mt-5 space-y-2">
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
          disabled={!canRecord}
          className="w-full rounded-xl bg-brand-primary py-3 text-sm font-bold text-white active:opacity-90 disabled:bg-gray-300"
        >
          填寫授課記錄
        </button>
      </section>
    </div>
  );
}
