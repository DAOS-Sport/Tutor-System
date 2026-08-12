import React, { useEffect, useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
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

// 這一頁看得到的狀態。以逗號串起來交給後端過濾，前端不再自己 .filter。
const REFUND_STATUSES = ['active', 'confirmed', 'cancelled', 'refunded'];

const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

/**
 * 搜尋比對。資料已經載入，所以在前端做 —— 即時、不用每個按鍵打一次 API。
 *
 * 電話另外比對「純數字」：櫃檯常直接從別處貼過來，帶著空白或破折號
 * （0912-345-678 / 0912 345 678）。只做字面比對的話那些都會查不到，
 * 而使用者只會看到「查無資料」，不會知道是格式問題。
 */
function matchesQuery(row, q, venueName) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const digits = onlyDigits(needle);
  if (digits && digits.length >= 3 && onlyDigits(row.parent_phone).includes(digits)) return true;
  const haystack = [
    row.id, row.parent_name, row.parent_phone, row.coach,
    venueName(row.venue_id), ...(row.students || []),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

export default function RefundPage() {
  const toast = useToast();
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [target, setTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [category, setCategory] = useState('');   // 申請原因（下拉，必填）
  const [detail, setDetail] = useState('');       // 詳述原因（必填）
  const [feePct, setFeePct] = useState('');       // 手續費率，以「百分比字串」持有（輸入框就是這個單位）
  const [feeOpen, setFeeOpen] = useState(false);  // 手續費率的下拉是否展開
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');       // 搜尋字串（前端即時過濾，不重打 API）
  const previewReqRef = useRef(0);

  async function load() {
    try {
      const [data, vs] = await Promise.all([
        // 狀態改由後端過濾（GET /enrollments 的 status 支援逗號分隔多值）。
        // 以前是整包撈回來再在前端 .filter —— 多傳的那些列除了拖慢載入沒有任何用途。
        // 含 refunded：已退費紀錄保留在清單中，供查看「退費時間」（操作欄顯示「已退費」）。
        enrollmentsApi.list({ status: REFUND_STATUSES.join(',') }),
        venuesApi.list(),
      ]);
      setList(data);
      setVenues(vs);
    } catch (e) {
      // 載入失敗時跳出無限轉圈：顯示空清單 + toast 引導重新整理
      toast.error(e?.response?.data?.error || '載入報名清單失敗，請重新整理頁面');
      setList([]);
    }
  }
  useEffect(() => { load(); }, []);

  async function openRefund(row) {
    setTarget(row);
    setCategory('');
    setDetail('');
    setFeePct('');
    setPreview(null);
    const reqId = ++previewReqRef.current;
    try {
      const p = await enrollmentsApi.refundPreview(row.id);
      // 若使用者在 fetch 中又開了另一列、或關閉 modal，丟掉這次回應
      if (reqId !== previewReqRef.current) return;
      setPreview(p);
      // 手續費率預帶全域設定值，讓櫃檯看得到「原本是多少」再決定要不要改
      setFeePct(String(Math.round((p.fee_rate ?? 0) * 1000) / 10));
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
  async function reprice(nextPct) {
    setFeePct(nextPct);
    if (!target) return;
    const pct = Number(nextPct);
    if (nextPct === '' || !Number.isFinite(pct) || pct < 0 || pct > 100) return;
    const reqId = ++previewReqRef.current;
    try {
      const p = await enrollmentsApi.refundPreview(target.id, Math.round(pct * 100) / 10000);
      if (reqId !== previewReqRef.current) return;
      setPreview(p);
    } catch {
      /* 重算失敗就維持上一次的試算結果，不要把已顯示的金額清掉 */
    }
  }

  const feePctInvalid =
    feePct !== '' && (!Number.isFinite(Number(feePct)) || Number(feePct) < 0 || Number(feePct) > 100);

  function closeRefund() {
    previewReqRef.current += 1; // 讓尚未回來的 preview 失效
    setTarget(null);
    setPreview(null);
  }

  async function doRefund() {
    if (!category) {
      toast.warning('請選擇申請原因');
      return;
    }
    if (!detail.trim()) {
      toast.warning('請填寫詳述原因');
      return;
    }
    if (feePctInvalid) {
      toast.warning('手續費率請填 0 到 100 之間的數字');
      return;
    }
    setBusy(true);
    try {
      const res = await enrollmentsApi.refund(target.id, {
        reason_category: category,
        reason_detail: detail.trim(),
        // 送出的是 0–1 的比率；後端會再夾限一次，前端擋的是手滑不是安全邊界
        fee_rate: feePct === '' ? undefined : Math.round(Number(feePct) * 100) / 10000,
        by: user.name,
      });
      toast.success(res.family_shared
        ? `已完成整期退課（${(res.refunded_enrollment_ids || []).length} 筆子訂單一併退費），退款合計 ${formatTWD(res.refund_amount)}`
        : `已完成退課，退款 ${formatTWD(res.refund_amount)}`);
      closeRefund();
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '退課失敗，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  if (!list) return <LoadingSpinner fullPage />;
  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;
  const shown = list.filter((r) => matchesQuery(r, query, venueName));

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
      <PageHeader title="退課處理" subtitle="F-R04 · 退款 = 剩餘比例 × (1 − 手續費率)，金額一律由系統試算；手續費率可逐筆調整，調整會記入 audit log" />

      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <div className="relative flex-1 min-w-[240px]">
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
        <div className="text-xs text-gray-500">
          {/* 搜尋時要同時給「找到幾筆」與「總共幾筆」——只給前者的話，
              查不到時分不出是「沒有這個人」還是「清單根本沒載到」。 */}
          {query ? <>符合 <span className="font-bold text-brand-primary">{shown.length}</span> / 共 {list.length} 筆</> : <>共 {list.length} 筆</>}
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={shown}
        rowKey={(r) => r.id}
        empty={query ? `找不到符合「${query}」的資料` : '目前沒有可退費的課程'}
      />

      <ConfirmDialog
        open={!!target}
        title={`退課 ${target?.id || ''}`}
        confirmLabel="確認退課退費"
        tone="danger"
        onCancel={closeRefund}
        onConfirm={doRefund}
        busy={busy}
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
                <span className="text-gray-600">手續費率</span>
                <span className="relative flex items-center gap-1">
                  <span className={`flex items-stretch overflow-hidden rounded-lg border ${
                    feePctInvalid ? 'border-brand-error bg-brand-error-soft' : 'border-gray-300'
                  }`}>
                    <input
                      type="text" inputMode="decimal" aria-label="手續費率（百分比）"
                      value={feePct}
                      onChange={(e) => reprice(e.target.value)}
                      onFocus={() => setFeeOpen(false)}
                      className="w-16 bg-transparent px-2 py-1 text-right font-mono outline-none"
                    />
                    <button
                      type="button"
                      aria-label="選擇常用手續費率"
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
                  <span className="text-gray-600">%</span>
                  {feeOpen && (
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
              <li className="flex justify-between border-t border-gray-200 pt-2 font-bold text-brand-error-strong"><span>應退款金額</span><span className="font-mono">{formatTWD(preview.refund_amount)}</span></li>
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
