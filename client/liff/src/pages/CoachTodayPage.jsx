import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionsApi } from '../api/sessions';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { courseTypeLabel, formatTWDate, formatTWTime, checkinLabel } from '../utils/format';
import { promotionValueLabel } from '../utils/promotionLabel';
import { EnrollmentRow, EnrollmentStats, ENROLL_PREVIEW } from '../components/coach/EnrollmentRow';


export default function CoachTodayPage() {
  const { coach } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [sessions, setSessions] = useState(null);
  const [enroll, setEnroll] = useState(null);
  const [promos, setPromos] = useState(null);

  useEffect(() => {
    if (!coach?.id) return;
    let alive = true;
    sessionsApi.todayByCoach(coach.id)
      .then((d) => alive && setSessions(d || []))
      .catch(() => { if (alive) { setSessions([]); toast.error('今日課程載入失敗'); } });
    return () => { alive = false; };
  }, [coach?.id, toast]);

  // 報名狀態與優惠是「附加資訊」：載入失敗就安靜地不顯示那張卡，
  // 不要跳錯誤打斷教練看今日課程——那才是這一頁的主體。
  useEffect(() => {
    if (!coach?.id) return undefined;
    let alive = true;
    sessionsApi.enrollmentsByCoach(coach.id)
      .then((d) => alive && setEnroll(d || null))
      .catch(() => { if (alive) setEnroll(null); });
    sessionsApi.promotionsByCoach(coach.id)
      .then((d) => alive && setPromos(d?.promotions || []))
      .catch(() => { if (alive) setPromos([]); });
    return () => { alive = false; };
  }, [coach?.id]);

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
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 ${s.checked_in ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                    {s.checked_in ? checkinLabel(s.scheduled_at, s.checked_in_at) : '未簽到'}
                  </span>
                  <span className="text-brand-teal">點選進入授課 →</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 學生報名狀態：教練原本只看得到「已經開通的課」，家長說「我報名了」
          但課還沒出現時，他無從判斷是家長還沒付款、櫃檯還沒對帳、還是根本沒報。
          這裡只預覽最需要注意的幾筆，完整清單在 /coach/orders。 */}
      {enroll && (enroll.items || []).length > 0 && (
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-brand-primary">學生報名狀態</h3>
            {/* 「共 N 筆」與入口合成同一顆按鈕。兩個入口並存只會讓人猶豫該點哪個，
                而且舊版那句「另有 N 筆，詳情請洽櫃檯」是死路——看不到就是看不到。 */}
            <button
              type="button"
              onClick={() => navigate('/coach/orders')}
              className="shrink-0 rounded-full bg-brand-primary/10 px-3 py-1 text-[11px] font-bold text-brand-primary active:opacity-60"
            >
              全部 {enroll.total ?? enroll.items.length} 筆 ›
            </button>
          </div>

          <EnrollmentStats counts={enroll.counts} />

          <div className="space-y-2">
            {enroll.items.slice(0, ENROLL_PREVIEW).map((it) => (
              <EnrollmentRow key={it.id} item={it} onClick={() => navigate('/coach/orders')} />
            ))}
          </div>
        </section>
      )}

      {/* 目前套用到這位教練的優惠。教練被家長問「現在有沒有活動」時答得出來。 */}
      {promos && promos.length > 0 && (
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-brand-primary">進行中的優惠</h3>
            <span className="text-xs text-gray-500">套用到你的課程</span>
          </div>
          <div className="space-y-1.5">
            {promos.map((p) => (
              <div key={p.id} className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-bold text-amber-900">🎟 {p.name}</span>
                  <span className="shrink-0 text-[11px] font-bold text-amber-800">{promotionValueLabel(p)}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-amber-800/80">
                  <span>至 {String(p.end_date).slice(0, 10)}</span>
                  {p.coupon_code && <span className="rounded bg-amber-200 px-1.5 py-0.5 font-mono">{p.coupon_code}</span>}
                </div>
              </div>
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
