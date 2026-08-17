// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔全檔屬凍結範圍（共享課期整班扣課按鈕；不得恢復反灰硬擋）。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
//
// ── 已取得同意的變更紀錄 ──
// 2026-08-17 owner 明示要求（原話：「幫我在手動寇克那邊讓櫃台押上時間 可以讓櫃台
//   針對過去時間做補扣」）：新增選填的「扣課時間」欄位。扣課邏輯、整班簽到語意、
//   冪等機制一律不動 —— 只是把後端本來就支援的 occurred_at 開給櫃台填。
// ═══════════════════════════════════════════════════════════════════
import React, { useEffect, useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { manualDeductionsApi } from '../api/manualDeductions';
import DateTimePicker from '../../../shared/DateTimePicker.jsx';
import { formatTWDateTimeSeconds, taipeiInputToDate, toTaipeiDateTimeInput } from '../utils/format';

function createRequestId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* noop */ }
  return `manual-deduct-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// 後台沒有 icon font，圖示一律 inline SVG（比照其他頁）。
const ico = 'h-3.5 w-3.5 shrink-0';
const ClockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={ico} aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);
const ResetIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ico} aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
  </svg>
);
const InfoIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={ico} aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
  </svg>
);
const WarnIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ico} aria-hidden="true">
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" />
  </svg>
);

// 稿子裡「寫入欄位稽核對照」的那幾行。刻意用資料表欄位原名而不是中文別名：
// 這塊是給日後查帳的人對照資料庫用的，翻成中文反而對不回去。
function ContractRow({ label, value, tone = 'green' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-gray-400">{label}</span>
      <span className={`truncate font-bold ${tone === 'amber' ? 'text-brand-amber' : tone === 'teal' ? 'text-brand-teal' : 'text-brand-green'}`}>{value}</span>
    </div>
  );
}

/**
 * 扣課成功後的結果視窗：把「哪個時間寫進哪個欄位」攤開來。
 * 補扣最容易被誤解的就是這件事 —— 上課時間被押到過去，但「誰在什麼時候按的」
 * 仍然是現在。與其寫一句說明，不如把兩組時間並排給櫃台看。
 */
function ResultModal({ data, onClose }) {
  useEffect(() => {
    if (!data) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [data, onClose]);

  if (!data) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="扣課結果"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 bg-brand-green px-5 py-4 text-white">
          <div className="min-w-0">
            <h3 className="text-base font-bold leading-tight">{data.idempotent ? '已確認原操作（未重複扣除）' : '扣課成功'}</h3>
            <p className="mt-0.5 text-xs text-white/85">
              {data.idempotent
                ? '這組請求先前已完成，系統回傳同一筆紀錄'
                : '已寫入上課紀錄、簽到、餘額與不可覆寫的稽核紀錄'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="關閉" className="shrink-0 rounded p-1 text-white/80 hover:bg-white/15 hover:text-white">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="space-y-1.5 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
            <div className="flex justify-between"><span className="text-gray-500">學員</span><span className="text-sm font-bold text-gray-800">{data.studentName || '—'}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">扣除堂數</span><span className="text-sm font-bold text-brand-error">−{data.idempotent ? 0 : 1} 堂</span></div>
            <div className="flex justify-between"><span className="text-gray-500">最新剩餘堂數</span><span className="text-sm font-bold text-brand-teal">{data.remainingAfter} 堂</span></div>
            {data.rosterCount > 1 && (
              <div className="flex justify-between"><span className="text-gray-500">整班登記出席</span><span className="text-sm font-bold text-gray-800">{data.rosterCount} 位</span></div>
            )}
          </div>

          <div>
            <div className="mb-2 text-xs font-bold text-gray-800">寫入欄位對照</div>
            <div className="space-y-1.5 overflow-x-auto rounded-lg bg-brand-primary p-3 font-mono text-[11px]">
              <ContractRow label="course_sessions.scheduled_at" value={data.scheduledAtText} />
              <ContractRow label="checkin_records.checked_in_at" value={data.scheduledAtText} />
              <div className="mt-1 space-y-1.5 border-t border-white/15 pt-1.5">
                <ContractRow label="course_sessions.completed_at" value={`${data.completedAtText}（當下）`} tone="amber" />
                <ContractRow label="manual_lesson_deductions.created_at" value={`${data.completedAtText}（當下）`} tone="amber" />
              </div>
              <div className="mt-1 border-t border-white/15 pt-1.5">
                <ContractRow label="request_id" value={data.requestId || '—'} tone="teal" />
              </div>
            </div>
          </div>

          <p className="flex items-start gap-2 rounded-lg border border-brand-teal/30 bg-brand-teal/5 p-2.5 text-[11px] leading-5 text-gray-700">
            <span className="mt-0.5 text-brand-teal"><InfoIcon /></span>
            <span>
              {data.backdated
                ? '這是補扣：上課時間與簽到時間被押到你指定的時刻，教練端「授課記錄」與家長端「上課記錄」顯示的就是它；稽核紀錄仍記下你按下扣除的當下時間。'
                : '這是即時扣課：所有時間都是送出當下。'}
              {' '}櫃台代扣不發推播給教練，這堂課會直接出現在教練端的今日簽到與授課記錄。
            </span>
          </p>
        </div>

        <div className="flex justify-end border-t border-gray-200 bg-gray-50 px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg bg-brand-primary px-5 py-2 text-xs font-bold text-white hover:bg-brand-primary/90">關閉視窗</button>
        </div>
      </div>
    </div>
  );
}

// 解析「扣課時間」輸入框。回傳 { iso, error }；留空＝ { iso: null }（＝用送出當下）。
function parseOccurred(value) {
  if (!value) return { iso: null };
  const d = taipeiInputToDate(value);
  if (!d) return { iso: null, error: '扣課時間格式不正確' };
  // datetime-local 只到分，選在「現在這一分」不該被當成未來，容許 60 秒。
  if (d.getTime() > Date.now() + 60000) return { iso: null, error: '扣課時間不能填未來時間' };
  return { iso: d.toISOString() };
}

export default function ManualDeductionPage() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState('');
  // 欄位一進來就帶當下時間，櫃台看得到基準再往前調。
  // 但「有沒有動過」要另外記：沒動過就不送 occurred_at，交給伺服器決定時間。
  // 這不是潔癖 —— 永遠帶著預填值的話，扣課逾時後隔一分鐘重試，預填時間已經跳掉，
  // fingerprint 跟著變、request_id 也換一組，那次重試就不再是冪等的，可能真的扣兩堂。
  const [occurredAt, setOccurredAt] = useState(() => toTaipeiDateTimeInput(new Date()));
  const [occurredTouched, setOccurredTouched] = useState(false);
  const [resultModal, setResultModal] = useState(null);   // 結果視窗（勿命名為 result：deduct() 內已有同名區域變數）
  const [log, setLog] = useState([]);           // 本次操作紀錄（不是查資料庫，見下方卡片說明）
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const requestIdsRef = useRef(new Map());

  // 沒動過的欄位要跟著現在走，否則頁面開著半小時，上面寫的還是進來那一刻，
  // 而實際送出的是伺服器當下 —— 畫面說一套、做一套。輸入框正在被操作時跳過，
  // 免得使用者選日期選到一半值被抽換。
  useEffect(() => {
    if (occurredTouched) return undefined;
    const id = setInterval(() => {
      // 使用者正在這個欄位裡操作（按鈕或展開的面板）就不要抽換值。
      const el = document.getElementById('manual-deduction-occurred-at');
      const root = el && el.parentElement;
      if (root && root.contains(document.activeElement)) return;
      setOccurredAt(toTaipeiDateTimeInput(new Date()));
    }, 30000);
    return () => clearInterval(id);
  }, [occurredTouched]);

  async function search(e) {
    e?.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      toast.warning('請輸入至少 2 個字元（報名單號、家長姓名／手機或學員姓名）');
      return;
    }
    setLoading(true);
    try {
      const result = await manualDeductionsApi.search(q);
      setRows(Array.isArray(result) ? result : []);
      if (!Array.isArray(result) || result.length === 0) toast.info('查無可手動扣課的進行中課期');
    } catch (err) {
      toast.error(err?.response?.data?.error || '查詢課期失敗');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function deduct(row, student) {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      toast.warning('請先填寫扣課原因');
      return;
    }
    if (Number(row.remaining_sessions) < 1) {
      toast.error('此課期已無剩餘堂數，不能扣成負數');
      return;
    }
    // 沒動過＝不送 occurred_at，後端用接收當下時間（原本的行為，且重試仍冪等）。
    const { iso: pickedIso, error: occurredErr } = parseOccurred(occurredAt);
    if (occurredTouched && occurredErr) {
      toast.warning(occurredErr);
      return;
    }
    const occurredIso = occurredTouched ? pickedIso : null;
    if (occurredTouched && !occurredIso) {
      toast.warning('請確認上課時間');
      return;
    }
    const key = `${row.course_period_id}:${student.id}`;
    // request_id 的快取鍵必須含「會進後端 fingerprint 的欄位」。後端以
    // (request_id, fingerprint) 判冪等：同一個 request_id 配上不同的原因或時間
    // 會被擋成 409 IDEMPOTENCY_CONFLICT。扣課失敗後改字改時間再送是常見動作，
    // 沿用舊 request_id 會讓櫃台看到一個他無法理解的錯誤。
    const reqKey = `${key}:${trimmedReason}:${occurredIso || ''}`;
    if (busyKey) return;
    const requestId = requestIdsRef.current.get(reqKey) || createRequestId();
    requestIdsRef.current.set(reqKey, requestId);
    setBusyKey(key);
    try {
      const result = await manualDeductionsApi.create({
        course_period_id: row.course_period_id,
        student_id: student.id,
        reason: trimmedReason,
        request_id: requestId,
        ...(occurredIso ? { occurred_at: occurredIso } : {}),
      });
      const after = Number(result?.deduction?.remaining_after);
      setRows((prev) => prev.map((item) => (
        item.course_period_id === row.course_period_id
          ? {
            ...item,
            used_sessions: Number(item.used_sessions || 0) + (result?.idempotent ? 0 : 1),
            remaining_sessions: Number.isFinite(after)
              ? after
              : Math.max(0, Number(item.remaining_sessions || 0) - (result?.idempotent ? 0 : 1)),
          }
          : item
      )));
      requestIdsRef.current.delete(reqKey);
      const attendanceCount = Number(result?.attendance_count)
        || (Array.isArray(result?.deduction?.roster_snapshot) ? result.deduction.roster_snapshot.length : 0);
      const d = result?.deduction || {};
      // 上課時間＝我們送出的 occurred_at；沒送就是後端接收當下，用 ledger 的
      // created_at 當代表值（同一個 transaction，差距是毫秒等級）。
      const scheduledSrc = occurredIso || d.created_at || null;
      const entry = {
        key: `${d.id || requestId}`,
        id: d.id || '',
        requestId: d.request_id || requestId,
        studentName: d.student_name || student.name || '',
        reason: d.reason || trimmedReason,
        scheduledAtText: scheduledSrc ? formatTWDateTimeSeconds(scheduledSrc) : '—',
        completedAtText: d.created_at ? formatTWDateTimeSeconds(d.created_at) : '—',
        backdated: !!occurredIso,
        idempotent: !!result?.idempotent,
        remainingAfter: Number.isFinite(after) ? after : Math.max(0, Number(row.remaining_sessions || 0) - 1),
        rosterCount: attendanceCount,
      };
      setLog((prev) => [entry, ...prev].slice(0, 20));
      setResultModal(entry);
      toast.success(result?.idempotent
        ? '已確認原扣課操作，未重複扣除'
        : (row.is_shared_period && attendanceCount > 1
          ? `已扣除 1 堂，並為整班 ${attendanceCount} 位學員登記出席`
          : '已手動扣除 1 堂，餘額與上課紀錄已同步'));
    } catch (err) {
      // 保留 request_id，網路逾時後同一操作 retry 會回到同一筆 ledger，而非再扣一次。
      toast.error(err?.response?.data?.error || '手動扣課失敗，尚未變更畫面餘額');
    } finally {
      setBusyKey('');
    }
  }

  // 即時預覽用；與 deduct() 走同一支 parseOccurred，畫面說什麼就送什麼。
  const occurredPreview = parseOccurred(occurredAt);

  return (
    <div>
      <PageHeader title="手動扣課" subtitle="輸入報名單號、家長或學員查詢；每次扣 1 堂並留下不可覆寫的稽核紀錄" />

      <form onSubmit={search} className="mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <label htmlFor="manual-deduction-search" className="mb-1 block text-xs font-medium text-gray-600">查詢課期</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="manual-deduction-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="報名單號、家長姓名／手機或學員姓名"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none"
          />
          <button type="submit" disabled={loading} className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {loading ? '查詢中…' : '查詢'}
          </button>
        </div>
        {/* 時間左（3 成）、原因右（7 成）。時間欄位再寬也只是放同樣長度的一串日期，
            多的寬度全是留白；原因是自由輸入，寬度直接換成看得到的字數。
            用 10 欄格線切 3/7，比 arbitrary 值可靠（本專案踩過 Tailwind 任意值靜默失效）。 */}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-10">
          <div className="sm:col-span-3">
            <div className="mb-1 flex min-h-[22px] items-center justify-between gap-2">
              <label htmlFor="manual-deduction-occurred-at" className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
                <span className="text-brand-teal"><ClockIcon /></span>
                上課時間
                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-normal text-gray-500">
                  {occurredTouched ? '已指定' : '預設現在'}
                </span>
              </label>
              {occurredTouched && (
                <button
                  type="button"
                  onClick={() => { setOccurredTouched(false); setOccurredAt(toTaipeiDateTimeInput(new Date())); }}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-brand-teal hover:bg-brand-teal/10"
                >
                  <ResetIcon />重設為現在
                </button>
              )}
            </div>
            {/* 自繪面板取代原生 datetime-local：值格式一模一樣（YYYY-MM-DDTHH:MM），
                所以 taipeiInputToDate、max 比較、touched 判斷全都不用動。 */}
            <DateTimePicker
              id="manual-deduction-occurred-at"
              mode="datetime"
              value={occurredAt}
              max={toTaipeiDateTimeInput(new Date())}
              onChange={(v) => { setOccurredTouched(true); setOccurredAt(v); }}
            />
          </div>

          <div className="sm:col-span-7">
            <label htmlFor="manual-deduction-reason" className="mb-1 flex min-h-[22px] items-center text-xs font-medium text-gray-600">
              扣課原因 <span className="ml-1 text-brand-error">*</span>
            </label>
            <textarea
              id="manual-deduction-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 1000))}
              rows={1}
              placeholder="例如：經家長確認，補登 2026/07/12 已完成的課程"
              className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6 focus:border-brand-teal focus:outline-none"
            />
          </div>
        </div>

        {/* 只有真的改過時間才出橫幅。沒改就是即時扣課，那是常態，
            為常態長期佔一塊灰底提示等於在製造留白。 */}
        {occurredTouched && occurredPreview.error && (
          <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-brand-error/30 bg-brand-error-soft p-2.5 text-xs text-brand-error-strong">
            <span className="mt-0.5"><WarnIcon /></span>
            <span className="font-bold">{occurredPreview.error}</span>
          </div>
        )}
        {occurredTouched && occurredPreview.iso && (
          <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-brand-amber/30 bg-brand-amber/10 p-2.5 text-xs leading-5 text-gray-800">
            <span className="mt-0.5 text-brand-amber"><WarnIcon /></span>
            <span className="min-w-0 flex-1">
              <strong className="font-bold">補扣模式</strong>：這筆會補登為
              <strong className="font-bold"> {formatTWDateTimeSeconds(occurredPreview.iso)} </strong>
              （台北時間）的上課與簽到紀錄，並顯示在教練端「授課記錄」與家長端「上課記錄」；
              稽核仍記下你按扣除的當下。
            </span>
          </div>
        )}
      </form>

      {loading && <LoadingSpinner />}
      {!loading && rows.length === 0 && query && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500">尚無可扣課結果</div>
      )}
      <div className="space-y-3">
        {rows.map((row) => (
          <section key={row.course_period_id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-gray-800">{row.parent_name || '課期'} <span className="font-normal text-gray-500">{row.parent_phone || ''}</span></h2>
                <p className="mt-1 text-xs text-gray-500">{row.venue_name || row.venue_id} · {row.coach || '未標示教練'} · 報名 {row.admin_enrollment_id || '—'}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${Number(row.remaining_sessions) > 0 ? 'bg-brand-green/10 text-brand-primary' : 'bg-gray-100 text-gray-500'}`}>
                剩餘 {row.remaining_sessions} / {row.total_sessions} 堂
              </span>
            </div>
            {row.is_shared_period && (
              <p className="mt-2 rounded-lg border border-brand-teal/30 bg-brand-teal/5 px-3 py-2 text-xs leading-5 text-gray-700">
                此為共享課期（{(row.students || []).filter((s) => s.is_active !== false).map((s) => s.name).join('、')} 共用堂數）：
                扣課會建立一堂完成課程並為整班登記出席，整期共扣 1 堂，餘額與所有成員訂單同步。
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-100 pt-3">
              {row.is_shared_period ? (() => {
                // 共享課期＝整班一堂：只給一顆整班按鈕（點任一學員效果相同，
                // 逐學員按鈕會誤導成「各扣各的」）。人數與 anchor 都以「未停用學員」
                // 為準（與後端 attendanceRoster 的 is_active 過濾一致）；全停用時
                // 退回名單第一位，保留單人停用學員的補登語意。
                const activeStudents = (row.students || []).filter((s) => s.is_active !== false);
                const anchorStudent = activeStudents[0] || (row.students || [])[0];
                if (!anchorStudent) {
                  return <span className="text-xs text-gray-400">此課期沒有有效學員，無法扣課</span>;
                }
                const key = `${row.course_period_id}:${anchorStudent.id}`;
                const disabled = Number(row.remaining_sessions) < 1 || !!busyKey;
                return (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => deduct(row, anchorStudent)}
                    className="rounded-lg border border-brand-teal px-3 py-2 text-sm font-bold text-brand-teal transition hover:bg-brand-teal/10 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
                  >
                    {busyKey === key ? '正在扣除…' : `扣除 1 堂（整班 ${activeStudents.length || 1} 位簽到）`}
                  </button>
                );
              })() : (row.students || []).map((student) => {
                const key = `${row.course_period_id}:${student.id}`;
                const disabled = Number(row.remaining_sessions) < 1 || !!busyKey;
                return (
                  <button
                    key={student.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => deduct(row, student)}
                    className="rounded-lg border border-brand-teal px-3 py-2 text-sm font-bold text-brand-teal transition hover:bg-brand-teal/10 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
                  >
                    {busyKey === key ? `正在扣除 ${student.name}…` : `扣除 ${student.name} 1 堂`}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {log.length > 0 && (
        <section className="mt-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-gray-800">本次操作的扣課紀錄</h2>
            {/* 刻意不寫「近期紀錄」：這張表是本頁這次開著時送出的那幾筆，
                不是去資料庫查歷史（目前沒有列表 API）。寫成「近期」會讓櫃台
                以為重新整理後還在，然後懷疑資料掉了。 */}
            <span className="text-[11px] text-gray-400">只顯示本頁本次送出的；完整稽核在資料庫，不可覆寫</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-gray-600">
                  <th className="p-2.5 font-bold">紀錄 ID</th>
                  <th className="p-2.5 font-bold">學員</th>
                  <th className="p-2.5 font-bold">扣課原因</th>
                  <th className="p-2.5 font-bold">上課時間<span className="ml-1 font-mono font-normal text-gray-400">scheduled_at</span></th>
                  <th className="p-2.5 font-bold">實際操作時間<span className="ml-1 font-mono font-normal text-gray-400">created_at</span></th>
                  <th className="p-2.5 font-bold">標籤</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-gray-700">
                {log.map((e) => (
                  <tr key={e.key}>
                    <td className="p-2.5 font-mono text-gray-500" title={e.id}>{e.id ? e.id.slice(0, 8) : '—'}</td>
                    <td className="p-2.5 font-medium">{e.studentName || '—'}</td>
                    <td className="max-w-[220px] truncate p-2.5" title={e.reason}>{e.reason}</td>
                    <td className="whitespace-nowrap p-2.5 font-mono text-gray-600">{e.scheduledAtText}</td>
                    <td className="whitespace-nowrap p-2.5 font-mono text-gray-600">{e.completedAtText}</td>
                    <td className="whitespace-nowrap p-2.5">
                      {e.idempotent ? (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">重送確認</span>
                      ) : e.backdated ? (
                        <span className="rounded bg-brand-amber/15 px-1.5 py-0.5 text-[10px] font-bold text-brand-amber">補扣（事後補登）</span>
                      ) : (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">即時扣課</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ResultModal data={resultModal} onClose={() => setResultModal(null)} />
    </div>
  );
}
