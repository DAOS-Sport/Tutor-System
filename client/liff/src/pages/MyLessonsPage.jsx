// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔全檔屬凍結範圍（簽到按鈕狀態機：已簽＋簽到方姓名、無待確認分支）。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmModal from '../components/ConfirmModal';
import SlotPicker from '../components/SlotPicker';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { coursesApi } from '../api/courses';
import { lessonsApi } from '../api/lessons';
import { checkinsApi } from '../api/checkins';
import { courseTypeLabel, formatTWDate, formatTWTime, formatTWDateTime } from '../utils/format';
import SelfCheckinModal from '../components/SelfCheckinModal';

// 家長可自助簽到：尚未簽到（本家未簽、夥伴也未代簽）、且課程已確認/完成
// （不限上課當天，隨時可補簽）。團報一方簽到即整組生效——checked_in_by_name
// 有值代表夥伴家長已簽，按鈕轉為「已簽 · 姓名」不可再簽。
function canParentCheckin(r) {
  return !r.checked_in_at && !r.checked_in_by_name && !r.partner_checkin_label
    && ['confirmed', 'completed'].includes(r.session_status);
}

export default function MyLessonsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { parent } = useAuth();
  const [searchParams] = useSearchParams();
  const periodParam = searchParams.get('period') || '';

  const [courses, setCourses] = useState(null); // /api/courses/mine（含 0 預約的進行中課程）
  const [lessons, setLessons] = useState(null); // /api/courses/lessons（已預約 session）
  const [enrollId, setEnrollId] = useState('');
  const [open, setOpen] = useState(false);              // 課程包下拉
  const [expandedKey, setExpandedKey] = useState(null); // 內嵌預約：展開中的佔位 key
  const [checkinBusyKey, setCheckinBusyKey] = useState(null);
  // 自助簽到模式的課期，從「尚未上課」那格直接簽到（不經過預約時段）。
  const [selfCheckinPeriodId, setSelfCheckinPeriodId] = useState(null);
  const [confirmRow, setConfirmRow] = useState(null);

  function load() {
    return Promise.allSettled([coursesApi.myCourses(parent.id), lessonsApi.mine({})])
      .then(([cRes, lRes]) => {
        setCourses(cRes.status === 'fulfilled' && Array.isArray(cRes.value) ? cRes.value : []);
        setLessons(lRes.status === 'fulfilled' && Array.isArray(lRes.value) ? lRes.value : []);
        if (cRes.status !== 'fulfilled' && lRes.status !== 'fulfilled') toast.error('上課記錄載入失敗');
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent.id]);

  async function handleCheckin(r) {
    const key = r.session_id + r.student_id;
    if (checkinBusyKey) return;
    setCheckinBusyKey(key);
    try {
      await checkinsApi.create({ sessionId: r.session_id, studentId: r.student_id });
      // 共班簽到會一次寫入整組 active roster；重抓兩個清單才能讓同家庭其他學員、
      // 團報夥伴代簽標籤與共享剩餘堂數同時更新，不只改目前點擊的那一列。
      await load();
      toast.success(`${r.student_name} 已簽到`);
      setConfirmRow(null);
    } catch (err) {
      toast.error(err?.response?.data?.error || '簽到失敗');
    } finally {
      setCheckinBusyKey(null);
    }
  }

  // 以「課程期 × 學員」彙整成「報名（課程包）」：
  //  - 來源 1（/mine）：本家長進行中/已完成、且已開通(course_period_id)的課程 → 帶 total/教練/係數/學員，
  //    確保「0 預約」的課程也會出現（六堂全為待預約）。
  //  - 來源 2（/lessons）：已預約 session → 掛進對應報名的 records；未對到的自建（保底）。
  const enrollments = useMemo(() => {
    if (courses === null && lessons === null) return [];
    const m = new Map();
    for (const c of courses || []) {
      if (!c.course_period_id || c.lifecycle === 'closed') continue;
      const students = (c.students_detail && c.students_detail.length)
        ? c.students_detail
        : (c.students || []).map((s) => (typeof s === 'string' ? { id: null, name: s } : s));
      for (const st of students) {
        if (!st || !st.id) continue; // 無 student id 無法對應 session / 簽到
        const key = `${c.course_period_id}|${st.id}`;
        if (m.has(key)) continue;
        m.set(key, {
          id: key,
          periodId: c.course_period_id,
          coach: c.coach?.name || c.coach_name,
          group: courseTypeLabel(c.course_type),
          pct: Math.round((Number(c.pricing_multiplier) || 1) * 100),
          venue: c.venue?.name || '',
          student: st.name,
          studentId: st.id,
          total: Number(c.total_sessions) || 0,
          used: Number(c.used_sessions) || 0,
          isTrial: c.order_kind === 'trial',
          // 簽到模式決定未排課的那幾格要顯示「簽到」還是「預約上課」。
          // 後端未給時保守當成 booking——不要在不確定的情況下讓家長直接扣課。
          checkinMode: c.checkin_mode || 'booking',
          records: [],
        });
      }
    }
    for (const r of lessons || []) {
      const key = `${r.period_id}|${r.student_id}`;
      if (!m.has(key)) {
        m.set(key, {
          id: key,
          periodId: r.period_id,
          coach: r.coach_name,
          group: courseTypeLabel(r.course_type),
          pct: Math.round((Number(r.pricing_multiplier) || 1) * 100),
          venue: r.venue_name || '',
          student: r.student_name,
          studentId: r.student_id,
          total: Number(r.total_sessions) || 0,
          used: Number(r.used_sessions) || 0,
          isTrial: r.is_experience_course === true,
          checkinMode: r.checkin_mode || 'booking',
          records: [],
        });
      }
      m.get(key).records.push(r);
    }
    // 剩餘堂數以共享 period 的 used_sessions 為主；records 計數作舊 API 保底。
    for (const e of m.values()) {
      const recordUsed = e.records.filter((r) => r.checked_in_at || r.checked_in_by_name || r.partner_checkin_label).length;
      e.remain = Math.max(0, e.total - Math.max(e.used || 0, recordUsed));
    }
    return Array.from(m.values());
  }, [courses, lessons]);

  // 預選：優先 ?period=，否則第一筆；資料變動後若目前選的不存在則重設。
  useEffect(() => {
    if (!enrollments.length) return;
    if (enrollments.some((e) => e.id === enrollId)) return;
    const byParam = periodParam && enrollments.find((e) => e.periodId === periodParam);
    setEnrollId(byParam ? byParam.id : enrollments[0].id);
  }, [enrollments, enrollId, periodParam]);

  const enrollment = enrollments.find((e) => e.id === enrollId) || enrollments[0] || null;

  // 上課明細排序：即將上課（未來）由近到遠在前；已出席（過去）由新到舊在後。
  const sortedRecords = useMemo(() => {
    if (!enrollment) return [];
    const now = Date.now();
    return [...enrollment.records].sort((a, b) => {
      const da = new Date(a.scheduled_at).getTime() - now;
      const db = new Date(b.scheduled_at).getTime() - now;
      const fa = da >= 0;
      const fb = db >= 0;
      if (fa && fb) return da - db;
      if (!fa && !fb) return db - da;
      return fa ? -1 : 1;
    });
  }, [enrollment]);

  // 六堂 = 已預約 records + 補足到 total 的「未預約」佔位。
  const items = useMemo(() => {
    const recs = sortedRecords.map((r) => ({ type: 'record', key: r.session_id + r.student_id, r }));
    const placeholderCount = Math.max(0, (enrollment?.total || 0) - sortedRecords.length);
    const phs = Array.from({ length: placeholderCount }, (_, i) => ({ type: 'placeholder', key: `ph-${i}` }));
    return [...recs, ...phs];
  }, [sortedRecords, enrollment]);

  // 切換報名時收合內嵌預約。
  useEffect(() => { setExpandedKey(null); }, [enrollId]);

  if (courses === null && lessons === null) return <LoadingSpinner label="載入中…" />;

  return (
    <div className="min-h-[calc(100dvh-3rem)] bg-gray-50">
      {enrollments.length === 0 ? (
        <div className="px-4 py-4">
          <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            沒有符合條件的上課記錄
          </div>
        </div>
      ) : (
        <>
          {/* 課程包選擇器 */}
          <div className="bg-white px-4 pb-4 pt-4">
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="flex w-full items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left shadow-sm active:bg-gray-50"
              >
                <EnrollmentLines e={enrollment} />
                <RemainBlock n={enrollment.remain} total={enrollment.total} />
                <ChevronDownIcon className={`shrink-0 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
              </button>

              {open && (
                <div className="absolute left-0 right-0 top-full z-50 mt-2 flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto rounded-2xl border border-gray-100 bg-white p-2 shadow-xl">
                  {enrollments.map((e) => {
                    const sel = e.id === enrollId;
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => { setEnrollId(e.id); setOpen(false); }}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left ${sel ? 'bg-gray-50' : 'active:bg-gray-50'}`}
                      >
                        <span className="w-5 shrink-0">{sel && <CheckIcon className="text-brand-primary" />}</span>
                        <EnrollmentLines e={e} compact />
                        <RemainBlock n={e.remain} total={e.total} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 上課明細（六堂） */}
          <div className="relative px-4 pb-6 pt-1">
            <div className="mb-2 px-1 text-xs text-gray-400">上課明細 · 共 {items.length} 筆</div>
            <div className="space-y-2.5">
              {items.map((it) => (
                it.type === 'record' ? (
                  <RecordCard
                    key={it.key}
                    r={it.r}
                    e={enrollment}
                    busy={checkinBusyKey === it.key}
                    onCheckin={() => setConfirmRow(it.r)}
                    onOpen={() => it.r.record_status === 'submitted' && navigate(`/history/${it.r.period_id}`)}
                  />
                ) : (
                  <PlaceholderCard
                    key={it.key}
                    e={enrollment}
                    expanded={expandedKey === it.key}
                    onToggle={() => setExpandedKey((k) => (k === it.key ? null : it.key))}
                    onBooked={() => { setExpandedKey(null); load(); }}
                    onSelfCheckin={() => setSelfCheckinPeriodId(enrollment.periodId)}
                  />
                )
              ))}
            </div>

            {/* 點擊外部 / 其他區域 收合內嵌預約（z-10：在內容卡之上、但在固定底部導覽列 z-30 之下） */}
            {expandedKey && (
              <button aria-label="收合" onClick={() => setExpandedKey(null)} className="fixed inset-0 z-10 cursor-default" />
            )}
          </div>

          {/* 課程包下拉的點擊外部關閉 */}
          {open && <button aria-label="關閉" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />}
        </>
      )}

      {/* 自助簽到模式：直接開既有的 SelfCheckinModal。它會向伺服器重抓最新狀態
          （剩餘堂數、今天是否已簽），不信任卡片上的舊資料；後端每日一次的唯一鍵
          與堂數上限也都還在，所以按錯或重按都不會多扣。 */}
      <SelfCheckinModal
        course={selfCheckinPeriodId ? { id: selfCheckinPeriodId } : null}
        onClose={() => setSelfCheckinPeriodId(null)}
        onDone={(result) => {
          setSelfCheckinPeriodId(null);
          if (result?.error) {
            toast.error(result.error);
          } else {
            toast.success(
              `簽到完成：${(result?.students || []).join('、')}`
              + (result?.remaining != null ? `（剩餘 ${result.remaining} 堂）` : '')
            );
          }
          load();
        }}
      />

      <ConfirmModal
        open={!!confirmRow}
        title="確認簽到"
        confirmLabel="確認簽到"
        busy={!!checkinBusyKey}
        onCancel={() => { if (!checkinBusyKey) setConfirmRow(null); }}
        onConfirm={() => confirmRow && handleCheckin(confirmRow)}
      >
        {confirmRow && (
          <>確定要為 <span className="font-bold text-brand-primary">{confirmRow.student_name}</span> 簽到嗎？簽到後將無法取消。</>
        )}
      </ConfirmModal>
    </div>
  );
}

// 右側大字：未上課堂數（剩） + 總堂數。
function RemainBlock({ n, total }) {
  return (
    <div className="shrink-0 text-right">
      <div className="text-lg font-bold leading-none tabular-nums text-brand-primary">
        {n}<span className="text-sm font-medium text-gray-400">/{total}</span>
      </div>
      <div className="mt-0.5 text-xs text-gray-400">未上課/總</div>
    </div>
  );
}

// 兩行：{教練}_{組別} ({修課係數%}) ／ {學員} · 共 N 堂
function EnrollmentLines({ e, compact }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-semibold text-brand-primary">
        {e.coach}_{e.group} <span className="font-medium text-gray-400">({e.pct}%)</span>
        {e.isTrial && (
          <span className="ml-1 rounded-md bg-brand-amber/15 px-1.5 py-0.5 text-[11px] font-medium text-brand-amber">
            試上・單堂
          </span>
        )}
      </div>
      <div className={`truncate text-xs text-gray-500 ${compact ? 'mt-0.5' : 'mt-1'}`}>
        {e.student} · 共 {e.total} 堂
      </div>
    </div>
  );
}

// 統一狀態正方形按鈕（等寬等高），右側對齊。
function StatusSquare({ label, tone, disabled, onClick }) {
  const toneCls = {
    book:     'bg-brand-primary/10 text-brand-primary active:bg-brand-primary/20',
    checkin:  'bg-brand-primary text-white active:opacity-90',
    attended: 'bg-brand-green/15 text-brand-green',
    pending:  'bg-gray-100 text-gray-400',
  }[tone] || 'bg-gray-100 text-gray-500';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick ? (ev) => { ev.stopPropagation(); onClick(); } : undefined}
      style={{ width: 68, height: 68 }}
      className={`flex shrink-0 flex-col items-center justify-center rounded-xl text-sm font-bold leading-tight disabled:cursor-default ${toneCls}`}
    >
      {/* 第二行（簽到方姓名等）縮小字級並截斷，避免長名字撐破 68px 方塊 */}
      {label.map((t, i) => (
        <span key={`${t}-${i}`} className={`max-w-full truncate px-1 ${i > 0 ? 'text-[11px] font-medium' : ''}`}>{t}</span>
      ))}
    </button>
  );
}

function RecordCard({ r, e, busy, onCheckin, onOpen }) {
  const checkinable = canParentCheckin(r);
  const clickable = r.record_status === 'submitted';

  const dateStr = formatTWDate(r.scheduled_at);
  const timeStr = formatTWTime(r.scheduled_at);

  const coachParts = [`${r.coach_name || e.coach} 教練`, e.group, r.venue_name || e.venue].filter(Boolean);
  const coachLine = coachParts.join('・');
  // 不可用 slice(0,10) 切 ISO 字串 —— 那切出來是 UTC 日期，台北 00:00~07:59 簽到的
  // 會顯示成前一天；而且標著「簽到時間」卻只有日期沒有時分。
  const checkinTimeStr = r.checked_in_at ? formatTWDateTime(r.checked_in_at) : null;

  // 簽到方家長姓名（團報一方簽到即整組生效）：有姓名顯示「已簽 · 姓名」；
  // 舊 API 快取只有稱謂 label 時退回「已代簽」。
  const signerName = r.checked_in_by_name || null;
  let btn;
  if (r.checked_in_at || signerName || r.partner_checkin_label) {
    btn = (
      <StatusSquare
        label={signerName ? ['已簽', signerName] : (r.partner_checkin_label ? ['已代簽'] : ['已出席'])}
        tone="attended"
        disabled
      />
    );
  } else if (checkinable) {
    btn = <StatusSquare label={busy ? ['簽到中'] : ['簽到']} tone="checkin" disabled={busy} onClick={onCheckin} />;
  } else {
    btn = <StatusSquare label={['即將', '上課']} tone="pending" disabled />;
  }

  return (
    <div
      onClick={clickable ? onOpen : undefined}
      className={`rounded-2xl border border-gray-100 bg-white p-4 shadow-sm ${clickable ? 'cursor-pointer active:bg-gray-50' : ''}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold tabular-nums text-gray-900">{dateStr}{timeStr}</div>
          <div className="mt-1 text-sm text-gray-700">{coachLine}</div>
          <div className="mt-0.5 text-sm text-gray-500">學員：{r.student_name || e.student}</div>
          {checkinTimeStr && (
            <div className="mt-0.5 text-xs text-gray-400">簽到時間：{checkinTimeStr}</div>
          )}
          {(signerName || r.partner_checkin_label) && (
            <div className="mt-1 text-xs font-medium text-brand-teal">
              已由 {signerName || r.partner_checkin_label} 代為簽到
            </div>
          )}
          {clickable && (
            <div className="mt-2 text-xs font-medium text-brand-teal">📝 教練已上傳上課紀錄，點擊查看 ›</div>
          )}
        </div>
        <div className="shrink-0">{btn}</div>
      </div>
    </div>
  );
}

// 未預約佔位卡：點卡片或「預約上課」展開內嵌時段選擇器（單選）。
// 展開時 z-[15]：浮在收合背板（z-10）之上、但仍低於 sticky 標頭（z-20）與固定底部導覽列（z-30），
// 避免卡片蓋過底部導覽列（破版）。未展開的卡片不抬升，維持一般文件流。
function PlaceholderCard({ e, expanded, onToggle, onBooked, onSelfCheckin }) {
  const coachLine = [`${e.coach} 教練`, e.group, e.venue].filter(Boolean).join('・');
  // 自助簽到模式的課期不需要先預約時間——家長是「來上課就簽到」。
  // 對這些課期顯示「預約上課」是錯的：他們沒有要挑時段，挑了也沒有意義。
  const selfMode = e.checkinMode === 'self';

  if (selfMode) {
    return (
      <div
        onClick={onSelfCheckin}
        className="cursor-pointer overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm transition active:bg-gray-50"
      >
        <div className="flex items-start gap-3 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-gray-400">尚未上課</div>
            <div className="mt-1 text-sm text-gray-700">{coachLine}</div>
            <div className="mt-0.5 text-sm text-gray-500">學員：{e.student}</div>
          </div>
          <StatusSquare label={['簽到']} tone="checkin" onClick={onSelfCheckin} />
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => { if (!expanded) onToggle(); }}
      className={`overflow-hidden rounded-2xl border bg-white shadow-sm transition ${
        expanded ? 'relative z-[15] border-brand-primary/60 ring-2 ring-brand-primary/40' : 'border-gray-100 cursor-pointer active:bg-gray-50'
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-gray-400">尚未預約時間</div>
          <div className="mt-1 text-sm text-gray-700">{coachLine}</div>
          <div className="mt-0.5 text-sm text-gray-500">學員：{e.student}</div>
        </div>
        <StatusSquare label={['預約', '上課']} tone="book" onClick={onToggle} />
      </div>

      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50/80" onClick={(ev) => ev.stopPropagation()}>
          <SlotPicker periodId={e.periodId} embedded onBooked={onBooked} />
        </div>
      )}
    </div>
  );
}

function ChevronDownIcon({ className = '' }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon({ className = '' }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
