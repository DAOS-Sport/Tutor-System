import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionsApi } from '../api/sessions';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { courseTypeLabel, formatTWDate, formatTWTime, checkinLabel } from '../utils/format';

/**
 * 教練端首頁（底部導覽第一個分頁）。
 *
 * 只有兩塊：教練資訊卡 + 今日課程。報名狀態、優惠、快捷鍵都搬走了 ——
 * 教練早上開 app 要看的是「我今天幾點在哪帶誰」，其餘都是另外一件事。
 */
export default function CoachTodayPage() {
  const { coach } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [sessions, setSessions] = useState(null);

  useEffect(() => {
    if (!coach?.id) return;
    let alive = true;
    sessionsApi.todayByCoach(coach.id)
      .then((d) => alive && setSessions(d || []))
      .catch(() => { if (alive) { setSessions([]); toast.error('今日課程載入失敗'); } });
    return () => { alive = false; };
  }, [coach?.id, toast]);

  if (!coach) return null;
  const todayLabel = formatTWDate(new Date());

  return (
    <div className="px-4 py-4">
      <section className="relative mb-5 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-primary to-brand-teal p-4 text-white shadow-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs opacity-90">{coach.name} 教練</p>
            <h2 className="mt-1 text-lg font-bold">{todayLabel}</h2>
          </div>
          {coach.is_senior && (
            <span className="flex shrink-0 items-center gap-1 rounded-xl border border-white/25 bg-white/15 px-2.5 py-1 text-[11px] font-bold tracking-wider shadow-inner backdrop-blur-sm">
              <span className="text-sm">🏅</span>資深 ×{coach.pricing_multiplier || coach.multiplier || 1}
            </span>
          )}
        </div>
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
                {/* 簽到狀態與入口一起靠右（比照家長端）。原本兩者擠在左下、右側整片空白，
                    而「點選進入授課 →」講的是動作，教練進去要做的其實是填授課記錄，
                    所以直接叫它進去之後看到的那個名字。

                    ⚠️ 整張卡本身就是一顆 <button>，這裡只能用 <span> 做出按鈕的樣子 ——
                    巢狀 button 是不合法的 HTML，React 也會警告。 */}
                <div className="mt-1.5 flex items-center justify-end gap-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 ${s.checked_in ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                    {s.checked_in ? checkinLabel(s.scheduled_at, s.checked_in_at) : '未簽到'}
                  </span>
                  <span className="rounded-full bg-brand-teal/10 px-2.5 py-0.5 font-bold text-brand-teal">
                    填寫授課記錄 →
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 首頁只留「教練資訊卡 + 今日課程」。原本這裡還有三塊，都搬走了：
          ・學生報名狀態 → 底部導覽的「報名記錄」分頁（原本只預覽 5 筆，看不出全貌）
          ・進行中的優惠 → 個人頁
          ・排課總表／個人介紹兩顆快捷鍵 → 底部導覽本來就有，重複入口只會讓人猶豫 */}
    </div>
  );
}
