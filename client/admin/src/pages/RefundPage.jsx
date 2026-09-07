import React, { useEffect, useMemo, useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import ListFooter from '../components/ListFooter';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
import useInfiniteList from '../hooks/useInfiniteList';
import useIsDesktop from '../hooks/useIsDesktop';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { enrollmentsApi } from '../api/enrollments';
import { venuesApi } from '../api/venues';
import {
  formatTWD, courseTypeLabel,
  paymentStatusLabel, paymentStatusTone, formatTWDateTime,
} from '../utils/format';
// 與後端 server/services/refundReasons.js 是同一份清單的兩個鏡射，
// tests/refund_reason_parity_test.js 會比對兩邊；改一邊沒改另一邊會紅。
import { REFUND_REASONS, REFUND_FEE_RATE_PRESETS } from '../../../shared/refundReasons';

const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

// 含 refunded：已退費紀錄保留在清單中，供查看「退費時間」（操作欄顯示「已退費」）。
const REFUNDABLE_STATUSES = ['active', 'confirmed', 'cancelled', 'refunded'];

/**
 * 搜尋字串 → 後端的 search 參數。
 *
 * ── 為什麼搜尋一定要走後端 ──
 * 清單改成分批載入之後，前端過濾只看得到「已經捲下來的那幾批」。這一頁的主要用法
 * 是櫃檯接到電話當場查一筆，若那筆還沒被載進來，畫面會回「找不到符合…的資料」——
 * 一個看起來很肯定、實際上是錯的答案。這比慢還糟，所以比對交給後端做。
 *
 * ── 為什麼要先壓成純數字 ──
 * 櫃檯常直接把電話從別處貼過來，帶著空白或破折號（0912-345-678）。
 * 資料庫存的是純數字，原樣送過去一筆也比不到。整串都是電話樣式時才壓，
 * 夾雜文字（「王小明 0912」）不壓，否則姓名會被毀掉。
 */
function toServerSearch(q) {
  const s = String(q || '').trim();
  if (!s) return '';
  const digits = onlyDigits(s);
  if (digits.length >= 3 && /^[\d\s()+-]+$/.test(s)) return digits;
  return s;
}

export default function RefundPage() {
  const toast = useToast();
  const { user } = useAuth();
  const [venues, setVenues] = useState([]);
  const [target, setTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [category, setCategory] = useState('');   // 申請原因（下拉，必填）
  const [detail, setDetail] = useState('');       // 詳述原因（必填）
  const [feePct, setFeePct] = useState('');
  const [feeMode, setFeeMode] = useState('rate');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [feeOpen, setFeeOpen] = useState(false);  // 手續費率的下拉是否展開
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');       // 搜尋字串（送到後端查，見 toServerSearch）
  const [searchTerm, setSearchTerm] = useState('');  // 去抖後真正送出的那一份
  const [reloadKey, setReloadKey] = useState(0);     // 退費成功後重新拉第一批
  const previewReqRef = useRef(0);

  // 場館清單獨立載入：它只是把 venue_id 翻成名字，失敗時退回顯示代碼即可，
  // 不該連帶讓整張報名清單變成空的。
  useEffect(() => {
    let alive = true;
    venuesApi.list()
      .then((vs) => { if (alive) setVenues(vs); })
      .catch(() => { if (alive) toast.warning('場館名稱載入失敗，清單會顯示場館代碼'); });
    return () => { alive = false; };
  }, []);

  // 去抖：不去抖的話每按一個鍵就打一次後端，而且慢的那次可能後回來覆蓋掉新的。
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(toServerSearch(query)), 300);
    return () => clearTimeout(t);
  }, [query]);

  // 手機分批、桌機全量。斷點與 Tailwind 的 md: 同一個 768px。
  const isDesktop = useIsDesktop();

  const {
    items, loading, done, error, loadMore, sentinelRef,
  } = useInfiniteList(
    ({ limit, offset }) => enrollmentsApi.list({
      ...(searchTerm ? { search: searchTerm } : {}),
      ...(limit ? { limit } : {}),   // 全量模式不帶 limit
      offset,
    }),
    [searchTerm, reloadKey, isDesktop],
    // 手機分批 50 筆；桌機 pageSize=null＝全量，維持原本「一次顯示全部」。
    { pageSize: isDesktop ? null : 50 },
  );

  // 後端的 status 參數一次只吃一個值，而這一頁要看四種狀態，所以狀態仍在前端篩。
  // 這不會讓「到底了」誤判：useInfiniteList 判斷用的是後端這一批回了幾筆，
  // 不是畫面上留下幾筆。
  const list = useMemo(
    () => (items || []).filter((e) => REFUNDABLE_STATUSES.includes(e.status)),
    [items],
  );

  async function openRefund(row) {
    setTarget(row);
    setCategory('');
    setDetail('');
    setFeePct('');
    setFeeMode('rate');
    setPreviewBusy(true);
    setPreviewError('');
    setPreview(null);
    const reqId = ++previewReqRef.current;
    try {
      const p = await enrollmentsApi.refundPreview(row.id);
      // 若使用者在 fetch 中又開了另一列、或關閉 modal，丟掉這次回應
      if (reqId !== previewReqRef.current) return;
      setPreview(p);
      // 手續費率預帶全域設定值，讓櫃檯看得到「原本是多少」再決定要不要改
      setFeePct(String(Math.round((p.fee_rate ?? 0) * 10000) / 100));
      setPreviewBusy(false);
    } catch (e) {
      if (reqId !== previewReqRef.current) return;
      // 試算失敗：關閉 modal 並提示，避免卡在「試算中」的破損彈窗
      toast.error(e?.response?.data?.error || '退款試算失敗，請稍後再試');
      closeRefund();
    }
  }

  /**
   * 改手續費率就重新跟後端要一次試算。
   * **不在前端自己乘** —— 金額只能有一個計算來源，否則畫面顯示的和實際入帳的會分岔
   * （這正是 shared/coursePricing 那段註解在講的同一類事故）。
   */
  async function reprice(nextPct, mode = feeMode) {
    setFeePct(nextPct);
    setFeeMode(mode);
    const reqId = ++previewReqRef.current;
    setPreviewError('');
    setPreviewBusy(false);
    const value = Number(nextPct);
    if (!target || !nextPct.trim() || !Number.isFinite(value) || value < 0 ||
        (mode === 'rate' ? value > 100 : !Number.isSafeInteger(value))) {
      setPreviewError(mode === 'rate' ? '請輸入 0 到 100 的百分比' : '請輸入非負整數金額');
      return;
    }
    setPreviewBusy(true);
    try {
      const p = await enrollmentsApi.refundPreview(target.id,
        mode === 'rate' ? Math.round(value * 100) / 10000 : undefined,
        mode === 'amount' ? value : undefined);
      if (reqId !== previewReqRef.current) return;
      setPreview(p);
    } catch (e) {
      if (reqId !== previewReqRef.current) return;
      setPreviewError(e?.response?.data?.error || '重新試算失敗，請重新輸入後再確認');
    } finally {
      if (reqId === previewReqRef.current) setPreviewBusy(false);
    }
  }

  const feePctInvalid = !feePct.trim() || !Number.isFinite(Number(feePct)) || Number(feePct) < 0 ||
    (feeMode === 'rate' ? Number(feePct) > 100 : !Number.isSafeInteger(Number(feePct)));

  function closeRefund() {
    previewReqRef.current += 1; // 讓尚未回來的 preview 失效
    setTarget(null);
    setPreview(null);
  }

  async function doRefund() {
    if (busy || previewBusy || previewError || !preview) return;
    if (!category) {
      toast.warning('請選擇申請原因');
      return;
    }
    if (!detail.trim()) {
      toast.warning('請填寫詳述原因');
      return;
    }
    if (feePctInvalid) {
      toast.warning('請輸入有效的手續費');
      return;
    }
    setBusy(true);
    try {
      const res = await enrollmentsApi.refund(target.id, {
        reason_category: category,
        reason_detail: detail.trim(),
        // 送出的是 0–1 的比率；後端會再夾限一次，前端擋的是手滑不是安全邊界
        fee_rate: feeMode === 'rate' ? Math.round(Number(feePct) * 100) / 10000 : undefined,
        fee_amount: feeMode === 'amount' ? Number(feePct) : undefined,
        expected_refund_amount: preview.refund_amount,
        by: user.name,
      });
      toast.success(res.family_shared
        ? `已完成整期退課（${(res.refunded_enrollment_ids || []).length} 筆子訂單一併退費），退款合計 ${formatTWD(res.refund_amount)}`
        : `已完成退課，退款 ${formatTWD(res.refund_amount)}`);
      closeRefund();
      setReloadKey((k) => k + 1);
    } catch (e) {
      toast.error(e?.response?.data?.error || '退課失敗，請稍後再試');
      if (e?.response?.status === 409) await reprice(feePct);
    } finally {
      setBusy(false);
    }
  }

  // items === null 代表第一批還沒回來（錯誤時會是 []，才不會卡在轉圈）
  if (items === null) return <LoadingSpinner fullPage />;
  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;
  // 過濾已經由後端做完，這裡不再二次篩 —— 前端篩只看得到已載入的批次，會答錯。
  const shown = list;

  const columns = [
    { key: 'id', label: '編號', render: (r) => <span className="font-mono text-xs">{r.id}</span> },
    { key: 'parent', label: '家長', render: (r) => <div><div className="font-medium">{r.parent_name}</div><div className="text-xs text-gray-500">{r.parent_phone}</div></div> },
    { key: 'students', label: '學員', render: (r) => r.students.join('、') },
    { key: 'coach', label: '教練 / 場館', render: (r) => <div>{r.coach}<div className="text-xs text-gray-500">{venueName(r.venue_id)}</div></div> },
    { key: 'course_type', label: '組別', render: (r) => courseTypeLabel(r.course_type) },
    { key: 'progress', label: '進度', render: (r) => <span className="font-mono text-sm">{r.used_sessions || 0} / {r.total_sessions || '—'}</span> },
    { key: 'final_price', label: '原應收', className: 'text-right', render: (r) => <span className="font-mono">{formatTWD(r.final_price)}</span> },
    { key: 'status', label: '狀態', render: (r) => <StatusBadge tone={paymentStatusTone(r.status)}>{paymentStatusLabel(r.status)}</StatusBadge> },
    {
      key: 'actions', label: '操作', className: 'text-right',
      render: (r) => r.status === 'refunded'
        ? <span className="text-xs text-gray-400">已退費</span>
        : (
          <button
            className="rounded-md bg-brand-error px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-error-strong"
            onClick={() => openRefund(r)}
          >
            退課退費
          </button>
        ),
    },
    { key: 'refunded_at', label: '退費時間', render: (r) => r.refunded_at ? <span className="font-mono text-xs">{formatTWDateTime(r.refunded_at)}</span> : <span className="text-gray-300">—</span> },
  ];

  return (
    <div>
      {/* 副標不寫「主管權限」——已開放櫃檯，留著會讓櫃檯以為自己不該按。
          也不再寫「不可手動更改」——手續費率已可逐筆調整，那句話會讓人以為那格不能動。
          現在講的是：公式、誰算的、哪一項可以動、動了會留痕。 */}
      <PageHeader title="退課處理" subtitle="手續費可選百分比或固定金額；固定金額按整期收取一次，退款由系統試算並保留調整紀錄" />
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        {/* 就地處理，不收編 FilterBar：整列只有一個搜尋框，而且它就是本頁的主要動作
            （櫃檯打電話進來時邊聽邊查）。把唯一的欄位收進「篩選」摺疊列，等於每次
            都多一次點擊才查得到，收編的成本大於收益。這裡只補上同一套手機規則。

            原本在 375px 會發生什麼：卡片 p-3 後只剩 351px，搜尋框是
            min-w-[240px] + flex-1、右邊那段「符合 N / 共 M 筆」約 90px，
            240 + 90 + gap-3 剛好擠得進同一列 —— 於是搜尋框被壓到 249px，
            再扣掉 pr-16（給「清除」鈕留的 64px），真正看得到的字只剩約 170px，
            長一點的關鍵字打進去就整段看不到頭尾。
            改成手機一格一列：搜尋框獨佔一整列，筆數掉到下一列、左緣切齊。

            flex-1 必須押在 md: —— flex-basis 會被設成 0%，優先於 width，
            留在無前綴會讓 w-full 在手機上失效、又擠回同一列。 */}
        <div className="relative w-full md:w-auto md:min-w-[240px] md:flex-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋：編號 / 家長 / 電話 / 學員 / 教練 / 場館"
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 pr-16 text-sm focus:border-brand-teal focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >清除</button>
          )}
        </div>
        <div className="w-full text-xs text-gray-500 md:w-auto">
          {/* 搜尋時要同時給「找到幾筆」與「總共幾筆」——只給前者的話，
              查不到時分不出是「沒有這個人」還是「清單根本沒載到」。 */}
          {query
            ? <>符合 <span className="font-bold text-brand-primary">{shown.length}</span> / 共 {list.length} 筆</>
            : <>共 {list.length} 筆</>}
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={shown}
        rowKey={(r) => r.id}
        empty={query ? `找不到符合「${query}」的資料` : '目前沒有可退費的課程'}
      />

      {/* 清單是空的時候 DataTable 自己已經有空狀態，這裡再說一次「沒有資料」
          會變成同一件事講兩遍；只有還在載、載失敗、或還有下一批時才需要頁尾。 */}
      {/* 桌機不掛頁尾：使用者要求桌機維持「一次顯示全部」，那就沒有下一批可載，
          而頁尾的哨兵（IntersectionObserver）也不該掛上去。載入中的轉圈在
          items === null 那一段本來就有，桌機看到的仍然是原本那個。 */}
      {!isDesktop && !(done && !error && list.length === 0) && (
        <ListFooter
          loading={loading}
          done={done}
          error={error}
          count={list.length}
          onRetry={loadMore}
          sentinelRef={sentinelRef}
        />
      )}

      <ConfirmDialog
        open={!!target}
        title={`退課 ${target?.id || ''}`}
        confirmLabel="確認退課退費"
        tone="danger"
        onCancel={closeRefund}
        onConfirm={doRefund}
        busy={busy}
        confirmDisabled={previewBusy || !!previewError || feePctInvalid || !preview}
      >
        {!preview ? (
          <div className="py-4"><LoadingSpinner label="計算退款中…" /></div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="rounded-lg bg-brand-error-soft p-3">
              <div className="mb-1 text-brand-error-strong"><b>家長：</b>{target.parent_name}（{target.parent_phone}）</div>
              <div className="text-brand-error-strong"><b>學員：</b>{target.students.join('、')}</div>
            </div>
            {preview.family_shared && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-800">
                <b>家庭共班・整期退費</b>：此課程為同堂共學（多位學員共用同一課程期）。
                確認後本期 <b>{(preview.sibling_ids || []).length} 筆</b>子訂單將
                <b>一併退費</b>（不支援退單一學員），課程期關閉、未上課的預約將取消並釋出教練時段。
              </div>
            )}
            <ul className="space-y-1 rounded-lg border border-gray-200 p-3">
              <li className="flex justify-between">
                <span className="text-gray-600">{preview.family_shared ? `原應收（整期 ${(preview.sibling_ids || []).length} 筆合計）` : '原應收'}</span>
                <span className="font-mono">{formatTWD(preview.family_shared ? preview.batch_final_price : preview.enrollment.final_price)}</span>
              </li>
              <li className="flex justify-between"><span className="text-gray-600">已使用堂數</span><span>{preview.used} / {preview.total}</span></li>
              <li className="flex justify-between"><span className="text-gray-600">剩餘比例</span><span>{(preview.remainRatio * 100).toFixed(1)}%</span></li>
              {/* 手續費率可逐筆調整：下拉選常用值，或直接打任意數字。
                  改完會重新跟後端要一次試算 —— 金額永遠由後端算，前端不自己乘。

                  ── 為什麼不用 <input type="number" list=""> ──
                  那個組合在 Chrome 會同時長出「數字微調鈕」與「datalist 箭頭」，
                  兩個控制項擠在同一格；而且 datalist 的箭頭只有 hover 才出現，
                  平常看起來就是普通輸入框，沒人知道可以下拉。
                  改成自己畫的 combobox：箭頭永遠看得到，且照樣能輸入。 */}
              <li className="flex items-center justify-between gap-3">
                <label className="text-gray-600">手續費
                  <select aria-label="手續費計算方式" value={feeMode} disabled={busy}
                    onChange={(e) => { setFeeOpen(false); reprice('0', e.target.value); }}
                    className="ml-2 rounded border border-gray-300 p-1">
                    <option value="rate">百分比</option><option value="amount">固定金額（整期一次）</option>
                  </select>
                </label>
                <span className="relative flex items-center gap-1">
                  <span className={`flex items-stretch overflow-hidden rounded-lg border ${
                    feePctInvalid ? 'border-brand-error bg-brand-error-soft' : 'border-gray-300'
                  }`}>
                    <input
                      type="text" inputMode="decimal" aria-label={feeMode === 'rate' ? '手續費率（百分比）' : '固定手續費（整數元）'} disabled={busy}
                      value={feePct}
                      onChange={(e) => reprice(e.target.value)}
                      onFocus={() => setFeeOpen(false)}
                      className="w-16 bg-transparent px-2 py-1 text-right font-mono outline-none"
                    />
                    <button
                      type="button"
                      aria-label="選擇常用手續費率" disabled={busy || feeMode !== 'rate'}
                      aria-expanded={feeOpen}
                      onClick={() => setFeeOpen((v) => !v)}
                      className="border-l border-gray-300 px-2 text-gray-500 hover:bg-gray-50"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                        <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6"
                              strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </span>
                  <span className="text-gray-600">{feeMode === 'rate' ? '%' : '元'}</span>
                  {feeOpen && feeMode === 'rate' && (
                    <ul className="absolute right-6 top-full z-20 mt-1 w-24 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                      {REFUND_FEE_RATE_PRESETS.map((r) => {
                        const pct = Math.round(r * 1000) / 10;
                        return (
                          <li key={r}>
                            <button
                              type="button"
                              onClick={() => { setFeeOpen(false); reprice(String(pct)); }}
                              className="block w-full px-3 py-1.5 text-right font-mono text-sm hover:bg-gray-100"
                            >
                              {pct}%
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </span>
              </li>
              {preview.default_fee_rate !== undefined
                && preview.fee_rate !== preview.default_fee_rate && (
                <li className="text-xs text-amber-700">
                  已調整（原定 {(preview.default_fee_rate * 100).toFixed(1)}%）——
                  這筆調整會連同你的帳號記入 audit log
                </li>
              )}
              <li aria-live="polite" className="text-sm text-brand-error-strong">{previewBusy ? '重新試算中…' : previewError}</li>
              <li className="flex justify-between border-t border-gray-200 pt-2 font-bold text-brand-error-strong"><span>應退款金額</span><span className="font-mono">{previewBusy || previewError ? '—' : formatTWD(preview.refund_amount)}</span></li>
            </ul>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="refund-category">
                <span className="text-brand-error">*</span> 申請原因
              </label>
              <select
                id="refund-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2"
              >
                <option value="">請選擇</option>
                {REFUND_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="refund-detail">
                <span className="text-brand-error">*</span> 詳述原因
                <span className="ml-1 font-normal text-gray-500">（會記入 audit log）</span>
              </label>
              <textarea
                id="refund-detail"
                rows={3}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2"
                placeholder="例：家長 8/20 搬遷至台中，已與教練確認不再續期"
              />
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
