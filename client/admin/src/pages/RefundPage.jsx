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
  const [busy, setBusy] = useState(false);
  const previewReqRef = useRef(0);

  async function load() {
    try {
      const [data, vs] = await Promise.all([
        enrollmentsApi.list(),
        venuesApi.list(),
      ]);
      // 含 refunded：已退費紀錄保留在清單中，供查看「退費時間」（操作欄顯示「已退費」）。
      setList(data.filter((e) => ['active', 'confirmed', 'cancelled', 'refunded'].includes(e.status)));
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
      {/* 副標不再寫「主管權限」——已開放櫃檯，留著會讓櫃檯以為自己不該按。
          改成講清楚金額怎麼來：這是最常被問的一件事，而且金額不可手改。 */}
      <PageHeader title="退課處理" subtitle="F-R04 · 退款 = 剩餘比例 × (1 − 手續費率)，金額由系統試算，不可手動更改" />
      <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="目前沒有可退費的課程" />

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
              {/* 手續費率可逐筆調整。下拉是常用值，也能直接打任意數字。
                  改完會重新跟後端要一次試算 —— 金額永遠由後端算，前端不自己乘。 */}
              <li className="flex items-center justify-between gap-3">
                <span className="text-gray-600">手續費率</span>
                <span className="flex items-center gap-1">
                  <input
                    type="number" min="0" max="100" step="0.5" inputMode="decimal"
                    value={feePct}
                    onChange={(e) => reprice(e.target.value)}
                    list="fee-rate-presets"
                    className={`w-24 rounded-lg border px-2 py-1 text-right font-mono ${
                      feePctInvalid ? 'border-brand-error bg-brand-error-soft' : 'border-gray-300'
                    }`}
                  />
                  <span className="text-gray-600">%</span>
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
            <datalist id="fee-rate-presets">
              {REFUND_FEE_RATE_PRESETS.map((r) => (
                <option key={r} value={Math.round(r * 1000) / 10} />
              ))}
            </datalist>

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
