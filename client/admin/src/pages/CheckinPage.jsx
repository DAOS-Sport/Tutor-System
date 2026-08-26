// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔凍結範圍：簽到人欄位顯示、WS checkin_id 去重。
// 2026-08-17：日期篩選框改用共用 DateTimePicker（owner「可以都換」）。
// 純呈現元件替換，值格式 YYYY-MM-DD 不變，不觸及上述凍結範圍。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
import React, { useEffect, useRef, useState } from 'react';
import DateTimePicker from '../../../shared/DateTimePicker.jsx';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { sessionsApi } from '../api/sessions';
import { checkinsApi } from '../api/checkins';
import { venuesApi } from '../api/venues';
import {
  formatTWD, courseTypeLabel,
  paymentStatusLabel, paymentStatusTone,
  isValidTWPhone,
  todayISO, formatHM,
} from '../utils/format';

export default function CheckinPage() {
  const toast = useToast();
  const { role, venueIds } = useAuth();
  const isStaff = role === 'staff';

  // 篩選器
  const [date, setDate] = useState(todayISO());
  // Task #90 修正：預設「全部（我的場館）」而非鎖單一主場館，讓多場館櫃檯看得到所有所屬場館。
  const [venueId, setVenueId] = useState('');
  const [venues, setVenues] = useState([]);

  // 列表
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);

  // 右上角查詢
  const [phone, setPhone] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const wsRef = useRef(null);
  const pollRef = useRef(null);

  // 載入場館清單（staff 也載入，用來提供「所屬多場館」下拉；下面再依 venueIds 過濾選項）
  useEffect(() => {
    let alive = true;
    venuesApi.list().then((d) => alive && setVenues(d || [])).catch(() => {});
    return () => { alive = false; };
  }, []);

  // staff 只能在自己所屬場館間切換；admin 顯示全部場館。
  const myVenues = isStaff ? venues.filter((v) => venueIds.includes(v.id)) : venues;

  // 拉清單
  async function reload() {
    setLoading(true);
    try {
      const r = await checkinsApi.list({ venueId: venueId || undefined, date });
      setList(Array.isArray(r) ? r : []);
    } catch {
      setList([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [venueId, date]);

  // WebSocket 即時推播；無 WS 時 fallback 30 秒輪詢
  useEffect(() => {
    if (date !== todayISO()) {
      // 看歷史日期不開 WS
      if (wsRef.current) { try { wsRef.current.close(); } catch{} wsRef.current = null; }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    let raw;
    try { raw = JSON.parse(localStorage.getItem('daos.admin.user') || 'null'); } catch {}
    const token = raw?.token;
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try { ws = new WebSocket(`${proto}//${location.host}/ws/admin?token=${encodeURIComponent(token)}`); } catch { ws = null; }
    let opened = false;
    if (ws) {
      ws.onopen = () => { opened = true; };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m?.type === 'checkin:created') {
            const d = m.data || {};
            // venue 篩選（client 端再保險一次）
            if (venueId && d.venue_id !== venueId) return;
            setList((prev) => {
              if (prev.some((x) => x.checkin_id === d.checkin_id)) return prev;
              return [d, ...prev];
            });
            toast.success(`新報到：${d.student}`);
          }
        } catch {}
      };
      ws.onerror = () => {};
      wsRef.current = ws;
    }
    // 30 秒 fallback 輪詢（即使有 WS 也保險，重整漏播時可補上）
    pollRef.current = setInterval(reload, 30000);
    // 若 1.5s 後 WS 還沒 open，視為失敗，僅靠輪詢
    const t = setTimeout(() => { if (!opened) { try { ws && ws.close(); } catch{} } }, 1500);
    return () => {
      clearTimeout(t);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (wsRef.current) { try { wsRef.current.close(); } catch{} wsRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, venueId]);

  async function onLookup(e) {
    e?.preventDefault();
    if (!phone && !periodId) { toast.warning('請輸入家長手機或報名編號'); return; }
    if (phone && !isValidTWPhone(phone)) { toast.error('手機格式不正確（09 + 8 碼）'); return; }
    setBusy(true);
    try {
      const r = await sessionsApi.verifyCheckin({ phone, periodId });
      setResult(r);
      if (!r.found) toast.error('查無此家長 / 報名');
    } finally { setBusy(false); }
  }
  function clearLookup() { setResult(null); setPhone(''); setPeriodId(''); }

  // U13：撤銷自助簽到（家長端不開放自撤，誤點一律由櫃檯在此更正）。
  // 撤銷＝該堂全部 attendance 標記 REVERSED、課堂取消、堂數歸還；不刪歷史。
  const [revokingId, setRevokingId] = useState(null);
  async function revokeSelf(row) {
    if (revokingId) return;
    const reason = window.prompt(
      `請填寫撤銷原因。這會將同一課堂全部學員的 attendance 標記為已復活，並歸還 1 堂。\n學員：${row.student}`,
      ''
    );
    if (reason == null) return;
    if (!reason.trim()) { toast.error('請填寫撤銷原因'); return; }
    setRevokingId(row.checkin_id);
    try {
      await checkinsApi.revokeSelfSession(row.session_id, reason.trim());
      toast.success('已撤銷自助簽到，堂數已歸還');
      await reload();
    } catch (e) {
      toast.error(e?.response?.data?.error || '撤銷失敗，請稍後再試');
    } finally {
      setRevokingId(null);
    }
  }

  // 簽到來源徽章：自助簽到（免預約模式）特別標示，讓櫃檯一眼分辨
  function sourceBadge(row) {
    if (row.session_created_via === 'self_checkin') return <StatusBadge tone="amber">自助</StatusBadge>;
    if (row.source === 'coach') return <StatusBadge tone="teal">教練</StatusBadge>;
    if (row.source === 'staff') return <StatusBadge tone="gray">櫃檯</StatusBadge>;
    return <StatusBadge tone="green">家長</StatusBadge>;
  }

  const isToday = date === todayISO();

  return (
    <div>
      <PageHeader title="簽到驗證" subtitle="F-R03 · 即時報到名單為主視覺；右上角保留家長手機 / 報名編號核對" />

      {/* 篩選列 + 右上角查詢區 */}
      {/* 就地處理，不收編 FilterBar：這一列的右半是「家長手機 / 報名編號」核對表單，
          那是櫃檯當場要用的查詢動作、不是篩選條件。整列包進 FilterBar 會把它一起
          收進「篩選」摺疊列後面，標籤與內容對不上，而且核對時每次都要多展開一次。
          所以只把同一套手機規則就地套上。 */}
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        {/* 原本在 375px 會發生什麼：這組三個控制項各自為政地折行 ——
            場館下拉是內容寬（跟著場館名字長短浮動，約 110–150px）、
            日期是死的 w-[168px]、「重新整理」是內容寬約 96px，
            三個右緣停在三個不同的位置，看起來像被啃過。
            手機改成一格一列、左右各切齊一條線；md 以上全部 w-auto / w-[168px]
            回到原值，桌機的橫排完全沒動。 */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full md:w-auto">
            <label className="mb-1 block text-xs font-medium text-gray-600">場館</label>
            <select
              value={venueId}
              onChange={(e) => setVenueId(e.target.value)}
              disabled={isStaff && myVenues.length <= 1}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100 md:w-auto"
            >
              <option value="">{isStaff ? '全部（我的場館）' : '全部場館'}</option>
              {myVenues.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
          <div className="w-full md:w-auto">
            <label className="mb-1 block text-xs font-medium text-gray-600">日期（台北）</label>
            <DateTimePicker
              value={date}
              onChange={(v) => setDate(v)}
              className="w-full md:w-[168px]"
            />
          </div>
          <button
            onClick={reload}
            className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 md:min-h-0 md:w-auto"
          >
            重新整理
          </button>
          {isToday && (
            <span className="text-xs text-emerald-600">● 即時更新中</span>
          )}
        </div>

        {/* 核對表單同樣就地補規則。原本在 375px：手機 w-32(128) + 編號 w-28(112)
            擠在同一列、右邊空出 80px，兩顆按鈕再折到下一列各自內容寬 ——
            四個元素四個右緣。這裡不強推「一格一列」（四列會把主清單壓到摺疊線以下），
            改成同列平分：兩個欄位各半、兩顆按鈕各半，右緣一次對齊。
            flex-1 一律配 md:flex-initial 復原成 flex: 0 1 auto（flex 的初始值），
            md 以上與原本沒有任何 flex 宣告時完全等價；寬度也用 md: 押回 w-32 / w-28。 */}
        <form onSubmit={onLookup} className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2">
          <div className="flex-1 md:flex-initial">
            <label className="mb-0.5 block text-[11px] font-medium text-gray-600">家長手機</label>
            <input
              type="tel" placeholder="09xxxxxxxx" value={phone}
              onChange={(e) => setPhone(e.target.value.trim())}
              className="min-h-[44px] w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm md:min-h-0 md:w-32"
            />
          </div>
          <div className="flex-1 md:flex-initial">
            <label className="mb-0.5 block text-[11px] font-medium text-gray-600">報名編號</label>
            <input
              type="text" placeholder="CP1001" value={periodId}
              onChange={(e) => setPeriodId(e.target.value.trim())}
              className="min-h-[44px] w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm md:min-h-0 md:w-28"
            />
          </div>
          <button
            type="submit" disabled={busy}
            className="min-h-[44px] flex-1 rounded-md bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50 md:min-h-0 md:flex-initial md:px-3 md:py-1.5"
          >
            {busy ? '查詢中…' : '核對'}
          </button>
          {(result || phone || periodId) && (
            <button
              type="button" onClick={clearLookup}
              className="min-h-[44px] flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-white md:min-h-0 md:flex-initial md:px-2 md:py-1.5 md:text-xs"
            >清除</button>
          )}
        </form>
      </div>

      {/* 主列表：今日報到（最新在最上方） */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h3 className="text-base font-bold text-brand-primary">
            {isToday ? '今日已報到（台北時間）' : `${date} 已報到（台北時間）`}
          </h3>
          <span className="text-sm text-gray-500">共 {list.length} 筆</span>
        </div>
        {loading ? (
          <div className="py-10"><LoadingSpinner /></div>
        ) : list.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">尚無報到紀錄</div>
        ) : (
          // 手機 6 欄分三行，桌機仍是 12 欄一行。
          // 375px 上這一列原本會爆版：main 的 p-4 之後只剩 311px 給 grid，
          // 扣掉 5 個 gap-2 是 271px、每欄 45px。CSS Grid 的 item 預設
          // min-width:auto、不會縮到 min-content 以下，而「自助」徽章
          // （px-2.5 + 兩個中文字）min-content 就 44px、撤銷鈕加報名編號
          // 要 106px —— 三個沒有 truncate 的欄位加起來把 grid 撐到 400px 上下，
          // 塞在 311px 的盒子裡，結果是整頁橫向捲動，主清單讀不了。
          //
          // 用 span 而不是 display:contents 換版：DOM 順序不變，
          // 桌機的欄位順序完全照舊，也不必賭瀏覽器對 contents 的支援。
          // 手機 6 欄的配置（每欄約 45px）：
          // 第一行 時間2 + 學員4
          // 第二行 組別4 + 場館2
          // 第三行 來源2 + 動作4     ← 徽章拿到 98px，不會再被擠爆
          <ul className="divide-y divide-gray-100">
            {list.map((r) => (
              <li key={r.checkin_id} className="grid grid-cols-6 items-center gap-x-2 gap-y-1.5 px-4 py-3 text-sm md:grid-cols-12 md:gap-y-2">
                <span className="col-span-2 font-mono text-brand-primary">{formatHM(r.at)}</span>
                <span className="col-span-4 truncate md:col-span-2">
                  <b>{r.student || '—'}</b>
                  {r.checked_in_by && (
                    <span className="block truncate text-xs text-gray-400">簽到人：{r.checked_in_by}</span>
                  )}
                </span>
                <span className="col-span-4 truncate text-gray-600 md:col-span-3">
                  {r.course_type ? courseTypeLabel(r.course_type) : '—'}
                  {r.is_experience_course && (
                    <span className="ml-1 rounded-full bg-teal-50 px-1.5 py-0.5 text-[11px] font-bold text-teal-700">試上</span>
                  )}
                  {r.coach ? <span className="ml-1 text-gray-400">· {r.coach}</span> : null}
                </span>
                <span className="col-span-2 truncate text-gray-500">{r.venue_name || r.venue_id}</span>
                <span className="col-span-2 md:col-span-1">{sourceBadge(r)}</span>
                <span className="col-span-4 flex items-center justify-end gap-2 md:col-span-2">
                  {r.session_created_via === 'self_checkin' && r.session_id && (
                    // 手機上放大到 44px：這是破壞性操作（整堂 attendance 標成
                    // REVERSED），而救生員多半是濕手在池畔按。桌機維持原本的
                    // 密度 —— 桌機使用者一次要看很多列，拉高會讓每頁看到的資料變少。
                    <button
                      type="button"
                      disabled={revokingId === r.checkin_id}
                      onClick={() => revokeSelf(r)}
                      className="min-h-[44px] rounded-md border border-brand-error px-3 py-2 text-sm font-bold text-brand-error hover:bg-brand-error-soft disabled:opacity-50 md:min-h-0 md:px-2 md:py-1 md:text-xs"
                    >
                      {revokingId === r.checkin_id ? '撤銷中…' : '撤銷'}
                    </button>
                  )}
                  <span className="text-xs text-gray-400">#{String(r.period_id || '').slice(-6)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 查詢結果（右上角查詢） */}
      {result && result.found && (
        <div className="mt-6 rounded-xl border-2 border-brand-green bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-bold text-brand-primary">驗證成功 ✓</h3>
            <StatusBadge tone={paymentStatusTone(result.enrollment.status)}>
              {paymentStatusLabel(result.enrollment.status)}
            </StatusBadge>
          </div>
          {/* 375px 上外層 p-6 之後只剩 277px，兩欄各 133px，
              而「家長姓名（0912345678）」一項就要 180px。 */}
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-gray-500">報名編號</dt><dd className="font-mono">{result.enrollment.id}</dd></div>
            <div><dt className="text-gray-500">家長</dt><dd>{result.enrollment.parent_name}（{result.enrollment.parent_phone}）</dd></div>
            <div><dt className="text-gray-500">學員</dt><dd>{result.enrollment.students.join('、')}</dd></div>
            <div><dt className="text-gray-500">組別</dt><dd>{courseTypeLabel(result.enrollment.course_type)}</dd></div>
            <div><dt className="text-gray-500">教練</dt><dd>{result.enrollment.coach}</dd></div>
            <div><dt className="text-gray-500">應收 / 已付</dt><dd>{formatTWD(result.enrollment.final_price)}</dd></div>
            {result.enrollment.total_sessions != null && (
              <div className="col-span-2">
                <dt className="text-gray-500">課程進度</dt>
                <dd>{result.enrollment.used_sessions || 0} / {result.enrollment.total_sessions} 堂</dd>
              </div>
            )}
          </dl>
          {result.session && (
            <div className="mt-4 rounded-lg bg-brand-green/10 p-3 text-sm text-brand-primary">
              <b>下一堂：</b>今天 {result.session.start}–{result.session.end}（{result.session.coach} 教練）
            </div>
          )}
        </div>
      )}

      {result && !result.found && (
        <div className="mt-6 rounded-xl border-2 border-brand-error bg-brand-error-soft p-6 text-center text-brand-error-strong">
          查無對應的報名資料，請確認家長手機或編號是否正確。
        </div>
      )}
    </div>
  );
}
