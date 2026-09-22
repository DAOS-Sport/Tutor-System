import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionsApi } from '../api/sessions';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { courseTypeLabel, formatTWDate, formatTWTime, formatPlainDate, checkinLabel } from '../utils/format';
import { promotionValueLabel } from '../utils/promotionLabel';

/**
 * 教練端首頁（底部導覽第一個分頁）。
 *
 * 三塊：教練資訊卡 + 進行中的優惠 + 今日課程。
 * 教練早上開 app 要看的是「我今天幾點在哪帶誰」，優惠夾在中間是因為它會影響
 * 家長的報名價，教練被問到時要答得出來 —— 埋在個人頁裡他不會每天去翻。
 * 報名狀態與快捷鍵仍在別的分頁，沒有搬回來。
 */
/**
 * 剩餘天數徽章的文字與配色。
 *
 * 顏色只分三級，刻意不做漸層：教練一眼要分出「要立刻打電話」跟「先知道一下」。
 * 一個月是營運上的分界 —— 六堂課的期別，剩不到一個月才開始需要催進度。
 * 色票一律走設計系統的 brand-*，不引入原生 orange/red（全 liff 已經有過
 * emerald 孤例的教訓，見 tests/coach_checkin_badge_style_test.js）。
 */
const EXPIRY_URGENT_DAYS = 30;
function expiryBadge(daysLeft) {
  if (daysLeft == null) return { text: '—', cls: 'bg-gray-100 text-gray-500' };
  if (daysLeft < 0) return { text: '已過期', cls: 'bg-brand-error text-white' };
  if (daysLeft === 0) return { text: '今天到期', cls: 'bg-brand-error text-white' };
  if (daysLeft <= EXPIRY_URGENT_DAYS) return { text: `剩 ${daysLeft} 天`, cls: 'bg-brand-amber/15 text-brand-amber' };
  return { text: `剩 ${daysLeft} 天`, cls: 'bg-brand-green/15 text-brand-green' };
}
export default function CoachTodayPage() {
  const { coach } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [sessions, setSessions] = useState(null);
  const [promos, setPromos] = useState(null);
  // 2026-09-01 需求：首頁要顯示 3 個月內即將到期的組數與清單。
  const [expiring, setExpiring] = useState(null);
  const [expandExpiring, setExpandExpiring] = useState(false);
  const [expiryError, setExpiryError] = useState(false);

  useEffect(() => {
    if (!coach?.id) return;
    let alive = true;
    sessionsApi.todayByCoach(coach.id)
      .then((d) => alive && setSessions(d || []))
      .catch(() => { if (alive) { setSessions([]); toast.error('今日課程載入失敗'); } });
    setExpiryError(false);
    setExpiring(null);
    sessionsApi.enrollmentsByCoach(coach.id)
      .then((d) => alive && setExpiring(d?.expiring || { count: 0, items: [] }))
      .catch(() => { if (alive) setExpiryError(true); });
    // 進行中優惠：附加資訊，失敗就安靜不顯示，不擋今日課程。
    sessionsApi.promotionsByCoach(coach.id)
      .then((d) => alive && setPromos(d?.promotions || []))
      .catch(() => alive && setPromos([]));
    return () => { alive = false; };
  }, [coach?.id, toast]);

  if (!coach) return null;
  const todayLabel = formatTWDate(new Date());

  return (
    <div className="px-4 py-4">
      <section className="relative mb-5 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-primary to-brand-teal p-4 text-white shadow-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs opacity-90">
              <span className="truncate">{coach.name} 教練</span>
              {/* 綠點＝「這是你本人的帳號」。教練在排課總表會看到一整排別人的名字，
                  首頁這顆點是他確認自己登入對帳號的唯一線索。 */}
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-green" />
            </p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight">{todayLabel}</h2>
          </div>
          {coach.is_senior && (
            <span className="flex shrink-0 items-center gap-1 rounded-xl border border-white/25 bg-white/15 px-2.5 py-1 text-[11px] font-bold tracking-wider shadow-inner backdrop-blur-sm">
              <span className="text-sm">🏅</span>資深 ×{coach.pricing_multiplier || coach.multiplier || 1}
            </span>
          )}
        </div>
      </section>

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
                  <span className="truncate text-sm font-bold text-amber-900">{p.name}</span>
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

      {/* 到期提醒：0 組與載入失敗分開呈現，不能把讀取失敗誤報為沒有到期課程。 */}
      {expiryError && (
        <p role="alert" className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          到期提醒暫時無法載入，請重新整理。
        </p>
      )}
      {expiring && (
        <section className="mb-5">
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
            <button
              type="button"
              onClick={() => setExpandExpiring((v) => !v)}
              aria-expanded={expandExpiring}
              className="flex w-full items-center justify-between gap-3 text-left active:opacity-80"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-sm font-bold text-amber-900">即將到期通知</span>
                <span className="shrink-0 rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-900">
                  {expiring.count} 組
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-amber-700">
                {expandExpiring ? '收合' : '查看'}
                <svg viewBox="0 0 12 12" aria-hidden="true"
                  className={`h-3 w-3 transition-transform ${expandExpiring ? '' : 'rotate-180'}`}>
                  <path d="M2 8L6 4l4 4" fill="none" stroke="currentColor"
                    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>

            {/* 這顆紅藥丸是「要做什麼」的提示，不是另一顆按鈕 —— 上面那顆已經負責
                展開／收合，再放一顆同義的按鈕只會讓人猶豫該按哪個。收合時也看得到，
                因為它才是這張卡存在的理由。 */}
            <p className="mt-3">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-error px-3 py-1.5 text-xs font-bold text-white shadow-sm">
                <span aria-hidden="true">⚠</span>請提醒家長進行授課
              </span>
            </p>
          </div>

          {expandExpiring && (
            <div className="mt-2 space-y-2">
              {expiring.items.length === 0 && <p className="p-3 text-sm text-gray-500">目前沒有 3 個月內到期的報名。</p>}
              {expiring.items.map((it) => {
                const badge = expiryBadge(it.days_left);
                return (
                  <button key={it.id} type="button"
                    onClick={() => navigate(`/coach/orders?enrollment=${encodeURIComponent(it.id)}`)}
                    className="w-full rounded-xl border border-gray-200 bg-white p-3 text-left shadow-sm active:bg-gray-50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 text-sm font-bold text-gray-900">
                        {(it.students || []).join('、') || '（無學員資料）'}
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${badge.cls}`}>
                        {badge.text}
                      </span>
                    </div>
                    {/* 「是哪一筆報名」要看得出來：組別、場館、期別、堂數缺一不可 ——
                        同一位學員可能有多期，只寫姓名教練找不到是哪一張單。 */}
                    <div className="mt-1 text-[11px] leading-5 text-gray-500">
                      {courseTypeLabel(it.course_type)}
                      {it.venue_name ? `・${it.venue_name}` : ''}
                      {it.period_number ? `・第 ${it.period_number} 期` : ''}
                      {it.total_sessions ? `・${it.used_sessions ?? 0}/${it.total_sessions} 堂` : ''}
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-400">
                      期限 {formatPlainDate(it.course_expires_at)} 23:59
                    </div>
                    <div className="mt-2 text-xs font-medium text-brand-teal">查看這筆報名 →</div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

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
                  {/* 已簽到章比照家長端上課記錄那顆（MyLessonsPage 的 StatusSquare tone="attended"）：
                      bg-brand-green/15 + text-brand-green。原本用的 emerald-100/700 是設計系統裡
                      沒有的原生色，全 liff 只有教練端這兩顆簽到章在用，站在家長旁邊看是另一種綠。 */}
                  <span className={`rounded-full px-2 py-0.5 font-medium ${s.checked_in ? 'bg-brand-green/15 text-brand-green' : 'bg-gray-100 text-gray-500'}`}>
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
