import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getRoomForPeriod } from '../api/chat';
import { coursesApi } from '../api/courses';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel, formatTWD, formatTWDate } from '../utils/format';

/**
 * 課程詳情頁（Part C）— 單筆已開通／待對帳課程的完整檢視。
 * 顯示教練・場館・課程類型・學員・堂數進度・到期日・實付金額・狀態・發票・團購共享。
 * 依 lifecycle 提供操作：active/completed → 學習歷程／約時間／選可用時段／課程轉讓／期末評鑑；
 * pending_payment → 前往付款（團報導向團購狀態頁，否則導向報名狀態頁）。
 */
const LIFECYCLE_META = {
  completed: { label: '已結束', cls: 'bg-gray-400 text-white' },
  active: { label: '進行中', cls: 'bg-brand-green text-white' },
  closed: { label: '已結束／已退費', cls: 'bg-gray-400 text-white' },
  pending_payment: { label: '待對帳', cls: 'bg-brand-amber text-white' },
};

export default function CourseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [course, setCourse] = useState(undefined); // undefined=loading, null=error
  const [openingRoom, setOpeningRoom] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    coursesApi.get(id)
      .then((d) => alive && setCourse(d || null))
      .catch(() => alive && setCourse(null));
    return () => { alive = false; };
  }, [id]);

  useEffect(() => load(), [load]);

  // getRoomForPeriod 解析聊天室再導向（與 MyCoursesPage 同邏輯；本地內聯，不共用）
  async function openRoom(periodId) {
    if (!periodId || openingRoom) return;
    setOpeningRoom(true);
    try {
      const r = await getRoomForPeriod(periodId);
      if (!r?.room_id) throw new Error('聊天室尚未建立');
      navigate(`/chat/${r.room_id}`);
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || '開啟聊天室失敗');
    } finally {
      setOpeningRoom(false);
    }
  }

  if (course === undefined) return <LoadingSpinner fullPage label="載入課程詳情…" />;
  if (course === null) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="mb-3 text-sm text-brand-error">找不到此課程</div>
        <button type="button" onClick={() => navigate('/my-courses', { replace: true })}
          className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white">前往我的課程</button>
      </div>
    );
  }

  const lifecycle = course.lifecycle || course.payment_status;
  const meta = LIFECYCLE_META[lifecycle] || { label: lifecycle, cls: 'bg-gray-300 text-gray-700' };
  const v = course.venue || {};
  const studentNames = (course.students || [])
    .map((s) => (typeof s === 'string' ? s : s.name)).filter(Boolean).join('、');
  const total = course.total_sessions || 0;
  const used = course.used_sessions || 0;
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const periodId = course.course_period_id;
  const isActiveOrDone = lifecycle === 'active' || lifecycle === 'completed';
  const isPending = lifecycle === 'pending_payment';
  const hasInvoice = course.invoice_number || course.invoice_image_url;

  return (
    <div className="px-4 py-4 pb-10">
      {/* 標題 + 狀態 */}
      <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-brand-primary/10 px-2 py-0.5 text-xs font-medium text-brand-primary">
                {courseTypeLabel(course.course_type)}
              </span>
              {course.is_group_shared && (
                <span className="rounded-md bg-brand-teal/15 px-2 py-0.5 text-xs font-medium text-brand-teal">
                  團購共享
                </span>
              )}
            </div>
            <h1 className="mt-1 truncate text-base font-bold text-gray-900">
              {(course.coach || '—')}{v.name ? ` · ${v.name}` : ''}
            </h1>
            <p className="mt-0.5 truncate text-xs text-gray-500">學員：{studentNames || '—'}</p>
            <p className="mt-1 truncate font-mono text-[11px] text-gray-400">訂單編號：{course.id}</p>
            {course.group_order_id && (
              <p className="mt-0.5 truncate font-mono text-[11px] text-gray-400">團購單號：{course.group_order_id}</p>
            )}
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.cls}`}>
            {meta.label}
          </span>
        </div>

        {/* 堂數進度（沿用 CourseCard 進度條樣式） */}
        <div className="mt-2 mb-1 flex items-center justify-between text-xs text-gray-600">
          <span>
            堂數進度 <span className="font-bold text-brand-primary">{used}/{total}</span>
          </span>
          <span>到期 {course.expires_at ? formatTWDate(course.expires_at) : '—'}</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div className="h-full rounded-full bg-brand-green transition-all" style={{ width: `${pct}%` }} />
        </div>

        <div className="mt-3 flex items-baseline justify-between border-t border-gray-100 pt-2 text-xs text-gray-500">
          <span>實付金額{course.period_count > 1 ? ` · ${course.period_count} 期` : ''}</span>
          <span className="text-base font-bold text-brand-primary">{formatTWD(course.final_price)}</span>
        </div>
      </div>

      {/* 發票 */}
      {hasInvoice && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
          <h3 className="mb-2 text-xs font-bold text-gray-600">發票</h3>
          {course.invoice_number && (
            <div className="text-sm text-gray-700">發票號碼：<span className="font-mono">{course.invoice_number}</span></div>
          )}
          {course.invoice_image_url && (
            <a
              href={course.invoice_image_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block rounded-lg border border-brand-teal px-3 py-2 text-sm font-bold text-brand-teal active:bg-brand-teal/10"
            >
              查看發票圖片
            </a>
          )}
        </div>
      )}

      {/* 操作 */}
      {isPending && (
        <button
          type="button"
          onClick={() => navigate(course.group_order_id ? `/group/${course.group_order_id}` : `/enroll-status/${id}`)}
          className="w-full rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white active:bg-brand-teal"
        >
          前往付款／上傳證明
        </button>
      )}

      {isActiveOrDone && periodId && (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => navigate(`/history/${periodId}`)}
            className="rounded-lg border border-brand-teal py-2.5 text-sm font-bold text-brand-teal active:bg-brand-teal/10"
          >
            學習歷程
          </button>
          <button
            type="button"
            disabled={openingRoom}
            onClick={() => openRoom(periodId)}
            className="rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white disabled:opacity-50 active:bg-brand-teal"
          >
            {openingRoom ? '開啟中…' : '約時間'}
          </button>
          <button
            type="button"
            onClick={() => navigate(`/book-slot/${periodId}`)}
            className="rounded-lg border border-brand-teal py-2.5 text-sm font-bold text-brand-teal active:bg-brand-teal/10"
          >
            選可用時段
          </button>
          <button
            type="button"
            onClick={() => navigate('/transfer/new')}
            className="rounded-lg border border-brand-teal py-2.5 text-sm font-bold text-brand-teal active:bg-brand-teal/10"
          >
            課程轉讓
          </button>
          {lifecycle === 'completed' && (
            <button
              type="button"
              onClick={() => navigate(`/evaluation/${id}`)}
              className="col-span-2 rounded-lg border border-brand-gold py-2.5 text-sm font-bold text-brand-gold active:bg-brand-gold/10"
            >
              期末評鑑
            </button>
          )}
        </div>
      )}

      {/* 已開通但正式課程期尚未建立（course_period_id 仍 null）→ 給說明，避免整頁無操作的軟死路 */}
      {isActiveOrDone && !periodId && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center text-sm text-gray-600">
          課程開通處理中，學習歷程／約時間等功能稍後開放。如有疑問請聯繫櫃台。
        </div>
      )}

      <button
        type="button"
        onClick={() => navigate('/my-courses')}
        className="mt-4 w-full rounded-lg border border-gray-300 py-2.5 text-sm font-bold text-gray-600"
      >
        前往我的課程
      </button>
    </div>
  );
}
