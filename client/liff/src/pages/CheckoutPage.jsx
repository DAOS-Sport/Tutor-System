import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { checkoutApi } from '../api/checkout';
import { enrollmentsApi } from '../api/enrollments';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel, formatTWD, formatTWYMD } from '../utils/format';
import { isPaymentProofCandidate, PAYMENT_PROOF_ACCEPT } from '../utils/paymentProofImage';

function formatInvoiceId(id) {
  const cleanId = String(id || '').replace(/-/g, '').toUpperCase();
  return cleanId ? `EM-${cleanId.slice(0, 8)}` : 'EM-BILLING';
}

function formatIssuedDate(input) {
  const ymd = formatTWYMD(input);
  return ymd ? ymd.replace(/-/g, '/') : '今日';
}

function orderStudentName(order) {
  const names = Array.isArray(order?.students)
    ? order.students.map((name) => String(name || '').trim()).filter(Boolean)
    : [];
  return order?.student_name || order?.student?.name || names.join('、') || '學員';
}

function groupSubOrdersByStudent(subOrders) {
  const grouped = new Map();
  (subOrders || []).forEach((order, index) => {
    const studentName = orderStudentName(order);
    const coachName = order.coach_name || order.coach?.name || order.coach || '場館教練';
    const courseType = order.course?.type_name || courseTypeLabel(order.course_type);
    const key = `${studentName}|${coachName}|${courseType}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        studentName,
        coachName,
        courseType,
        periods: [],
      });
    }
    grouped.get(key).periods.push({
      id: order.id || `${key}-${index}`,
      periodNumber: Number(order.period_number || order.period) || 1,
      totalSessions: Number(order.total_sessions) || 6,
      price: Number(order.final_price || order.price || order.amount) || 0,
    });
  });
  return Array.from(grouped.values());
}

function getCheckoutStatusMeta(paymentStatus, hasProof, last5, paymentMethod = 'bank_transfer') {
  const status = String(paymentStatus || '');
  const isCancelled = status === 'cancelled';
  const isPaid = status === 'paid' || status === 'completed';
  const isPendingReconcile = status === 'pending_reconcile' || status === 'reconciling' || (hasProof && last5);

  if (isCancelled) {
    return {
      label: '已取消',
      badgeClass: 'bg-slate-100 text-slate-500 border border-slate-200',
      step: 0,
      headline: '付款單已取消',
      body: '此付款單已取消，如需上課請重新報名。',
    };
  }
  if (isPaid) {
    return {
      label: '課程已開通',
      badgeClass: 'bg-brand-green/15 text-brand-primary border border-brand-green/40',
      step: 3,
      headline: '本期課程開通完成',
      body: '櫃檯已核對款項無誤，您的上課堂數已正式開通。',
    };
  }
  if (paymentMethod === 'on_site') {
    return {
      label: '待現場付費',
      badgeClass: 'bg-amber-50 text-amber-700 border border-amber-200',
      step: 2,
      headline: '請於上課前至場館櫃檯完成付款',
      body: '此試上訂單尚未付款；櫃檯完成收款與對帳後才會開通課程。',
    };
  }
  if (isPendingReconcile) {
    return {
      label: '對帳審核中',
      badgeClass: 'bg-brand-green/10 text-brand-primary border border-brand-green/30',
      step: 2.5,
      headline: '匯款證明回報完成',
      body: '櫃檯人員核對完畢後會立即開通您的上課堂數。',
    };
  }
  return {
    label: '待繳款／待櫃檯確認',
    badgeClass: 'bg-brand-primary/5 text-brand-primary border border-brand-primary/15',
    step: 2,
    headline: '完成轉帳後回報付款資料',
    body: '請填寫轉帳末 5 碼並上傳轉帳證明，以便櫃檯核對。',
  };
}

function SectionTitle({ children }) {
  return (
    <div className="mb-3 flex items-center gap-1.5">
      <span className="h-3 w-1 rounded-full bg-brand-green" />
      <h3 className="text-xs font-bold tracking-wider text-slate-800">{children}</h3>
    </div>
  );
}

export default function CheckoutPage() {
  const { checkoutId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const proofInputRef = useRef(null);
  const copyResetTimerRef = useRef(null);

  const [checkout, setCheckout] = useState(undefined);
  const [proofBusy, setProofBusy] = useState(false);
  const [transferLast5, setTransferLast5] = useState('');
  const [carrier, setCarrier] = useState('');
  const [parentNote, setParentNote] = useState('');
  const [proofFile, setProofFile] = useState(null);
  const [proofPreview, setProofPreview] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    checkoutApi.get(checkoutId)
      .then((d) => alive && setCheckout(d || null))
      .catch(() => alive && setCheckout(null));
    return () => { alive = false; };
  }, [checkoutId]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (checkout) {
      setTransferLast5(checkout.transfer_last_5 || '');
      setCarrier(checkout.carrier || localStorage.getItem('daos_invoice_carrier') || '');
      setParentNote(checkout.parent_note || '');
      setProofFile(null);
      setProofPreview('');
    }
  }, [checkout?.checkout_id, checkout?.transfer_last_5, checkout?.has_payment_proof, checkout?.carrier, checkout?.parent_note]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, []);

  const subOrders = checkout?.sub_orders || [];
  const groupedSubOrders = useMemo(() => groupSubOrdersByStudent(subOrders), [subOrders]);

  if (checkout === undefined) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center bg-white p-8">
        <LoadingSpinner label="載入帳單資訊中..." />
      </div>
    );
  }

  if (checkout === null) {
    return (
      <div className="mx-auto max-w-md bg-white px-4 py-12 text-center">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-error-soft text-brand-error">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.94 4h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.72 3z" />
          </svg>
        </div>
        <h3 className="mt-3 text-sm font-bold text-slate-800">載入失敗</h3>
        <p className="mt-1 text-xs text-slate-500">找不到此付款單資訊</p>
        <button
          type="button"
          onClick={() => navigate('/my-courses', { replace: true })}
          className="mt-6 rounded-lg bg-brand-primary px-5 py-2 text-xs font-bold text-white transition hover:bg-brand-primary/90"
        >
          返回我的課程
        </button>
      </div>
    );
  }

  const venue = checkout.venue || {};
  const isOnSite = checkout.payment_method === 'on_site';
  const accountHolder = venue.account_holder || venue.bank_account_name || '—';
  const bankName = venue.bank_institution_name || venue.bank_name || '—';
  const branchName = venue.bank_branch_name || '';
  const accountNumber = venue.account_number || venue.bank_account_number || '';
  const hasGroupOrder = subOrders.some((order) => order.group_order_id);
  const canUpload = !isOnSite && ['pending_payment', 'pending_reconcile'].includes(checkout.payment_status);
  const paymentLocked = canUpload && checkout.has_payment_proof && !!checkout.transfer_last_5;
  const showPaymentForm = canUpload && !paymentLocked;
  const validLast5 = /^\d{5}$/.test(transferLast5.trim());
  const submitDisabled = proofBusy || !validLast5 || (!proofFile && !checkout.has_payment_proof);
  const meta = getCheckoutStatusMeta(
    checkout.payment_status,
    checkout.has_payment_proof,
    checkout.transfer_last_5,
    checkout.payment_method,
  );
  const billingLabel = groupedSubOrders.length > 1
    ? `${groupedSubOrders.length}位 報名`
    : groupedSubOrders[0]?.courseType
      ? `${groupedSubOrders[0].courseType} 報名`
      : '課程報名';

  async function handleCopy(text) {
    if (!text) {
      toast.warning('目前無匯款帳號資料，請聯繫場館櫃檯');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textField = document.createElement('textarea');
        textField.value = text;
        textField.setAttribute('readonly', '');
        textField.style.position = 'fixed';
        textField.style.left = '-9999px';
        document.body.appendChild(textField);
        textField.select();
        document.execCommand('copy');
        document.body.removeChild(textField);
      }
      setCopied(true);
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = setTimeout(() => setCopied(false), 2000);
      toast.success('已複製轉帳帳號');
    } catch {
      toast.error('複製失敗，請手動長按複製帳號');
    }
  }

  function handleFileChange(file) {
    if (!file) return;
    if (!isPaymentProofCandidate(file)) {
      toast.warning('請上傳 JPG、PNG、WebP、HEIC、HEIF 或 AVIF 圖片');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.warning('檔案大小不可超過 5MB');
      return;
    }
    setProofFile(file);
    const reader = new FileReader();
    reader.onloadend = () => setProofPreview(String(reader.result || ''));
    reader.readAsDataURL(file);
    toast.info('已選取匯款憑證圖片');
  }

  async function handleSubmitPayment(e) {
    e.preventDefault();
    if (!validLast5) {
      toast.warning('請填寫匯出卡片的末 5 碼');
      return;
    }
    if (!proofFile && !checkout.has_payment_proof) {
      toast.warning('請上傳匯款／轉帳憑證截圖');
      return;
    }

    setProofBusy(true);
    let uploadedUrl = checkout.payment_proof_url || null;
    try {
      if (proofFile) {
        const uploaded = await enrollmentsApi.uploadPaymentProof(proofFile, {
          targetType: 'checkout',
          targetId: checkout.checkout_id,
        });
        uploadedUrl = uploaded?.url || uploaded?.data?.url || null;
        if (!uploadedUrl) throw new Error('圖片上傳解析錯誤');
      }

      await checkoutApi.uploadProof(checkout.checkout_id, {
        transfer_last_5: transferLast5.trim(),
        payment_proof_url: uploadedUrl || undefined,
        carrier: carrier.trim() || undefined,
        parent_note: parentNote.trim() || undefined,
      });

      if (carrier.trim()) localStorage.setItem('daos_invoice_carrier', carrier.trim());
      else localStorage.removeItem('daos_invoice_carrier');

      toast.success('付款證明已送出，櫃檯將儘速審核');
      setProofFile(null);
      setProofPreview('');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || err?.message || '送出對帳失敗，請稍後再試');
    } finally {
      setProofBusy(false);
    }
  }

  async function handleCancelCheckout() {
    if (cancelBusy) return;
    if (!window.confirm('確定要取消此筆課程報名與付款單嗎？')) return;
    setCancelBusy(true);
    try {
      await checkoutApi.cancel(checkout.checkout_id);
      toast.success('已成功取消報名');
      navigate('/my-courses', { replace: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || '取消付款單失敗');
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <div className="bg-slate-50 pb-12 font-sans text-slate-800 antialiased selection:bg-brand-green/20">
      <div className="mx-auto max-w-md px-4 pt-3">
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-white px-5 py-3 shadow-sm">
          <div className="flex flex-col items-center gap-1">
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-green/15 text-[10px] font-bold text-brand-primary">
              ✓
            </div>
            <span className="text-[10px] font-medium text-slate-400">送出報名</span>
          </div>
          <div className="mx-2 h-px flex-1 bg-slate-100" />
          <div className="flex flex-col items-center gap-1">
            <div className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold transition ${
              meta.step >= 2.5 ? 'bg-brand-green/15 text-brand-primary' : 'bg-brand-primary text-white shadow-sm'
            }`}
            >
              {meta.step >= 2.5 ? '✓' : '2'}
            </div>
            <span className={`text-[10px] font-bold ${meta.step >= 2.5 ? 'text-slate-400' : 'text-brand-primary'}`}>
              {isOnSite ? '現場付費' : '轉帳付款'}
            </span>
          </div>
          <div className="mx-2 h-px flex-1 bg-slate-100" />
          <div className="flex flex-col items-center gap-1">
            <div className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
              meta.step === 3
                ? 'bg-brand-primary text-white'
                : meta.step === 2.5
                  ? 'bg-brand-green text-brand-primary'
                  : 'bg-slate-100 text-slate-400'
            }`}
            >
              3
            </div>
            <span className={`text-[10px] font-medium ${
              meta.step === 2.5
                ? 'font-bold text-brand-primary'
                : meta.step === 3
                  ? 'font-bold text-brand-primary'
                  : 'text-slate-400'
            }`}
            >
              {meta.step === 2.5 ? '櫃檯審核' : '開通上課'}
            </span>
          </div>
        </div>
      </div>

      <div className="mx-auto mt-3 max-w-md space-y-3 px-4">
        <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div className="min-w-0">
              <span className="text-[10px] font-semibold tracking-wider text-slate-400">ACCOUNT BILLING</span>
              <h2 className="mt-0.5 truncate text-sm font-bold text-slate-700">{billingLabel}</h2>
            </div>
            <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold ${meta.badgeClass}`}>
              {meta.label}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-4">
            <span className="text-xs font-medium text-slate-500">應繳總金額</span>
            <span className="shrink-0 text-2xl font-black tracking-tight text-slate-900">
              {formatTWD(checkout.total_amount)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3 font-mono text-[10px] text-slate-400">
            <span className="min-w-0 truncate">帳單號：{formatInvoiceId(checkout.checkout_id)}</span>
            <span className="shrink-0">{formatIssuedDate(checkout.created_at || checkout.submitted_at)}</span>
          </div>
        </section>

        {isOnSite && (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
            <SectionTitle>現場付費說明</SectionTitle>
            <p className="text-xs font-semibold leading-relaxed text-amber-900">請於試上課程前至 {venue.name || '所選場館'} 櫃檯完成付款。此訂單目前是待對帳狀態，尚未標記為已付款。</p>
            <p className="mt-2 text-[11px] leading-relaxed text-amber-800">請向櫃檯提供帳單號 {formatInvoiceId(checkout.checkout_id)}；付款後由授權人員進行對帳與開通。</p>
          </section>
        )}

        <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
          <SectionTitle>本期課程細項</SectionTitle>
          <div className="space-y-3">
            {groupedSubOrders.length ? groupedSubOrders.map((studentData) => (
              <div
                key={studentData.key}
                className="rounded-lg border border-slate-100 bg-slate-50/50 p-3 transition hover:bg-slate-50"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-green/15 text-[11px] font-bold text-brand-primary">
                      {studentData.studentName.replace(/\s/g, '').slice(-2) || '學員'}
                    </div>
                    <div className="min-w-0">
                      <h4 className="truncate text-xs font-bold text-slate-800">{studentData.studentName}</h4>
                      <p className="mt-0.5 truncate text-[10px] font-medium text-slate-400">
                        {studentData.coachName}教練 · {studentData.courseType}
                      </p>
                    </div>
                  </div>
                  <span className="shrink-0 rounded border border-brand-green/20 bg-white px-2 py-0.5 text-[10px] font-bold text-brand-primary">
                    共 {studentData.periods.length} 期
                  </span>
                </div>

                <div className="mt-3 space-y-2 border-t border-slate-100/70 pt-2.5">
                  {studentData.periods.map((period) => (
                    <div key={period.id} className="flex items-center justify-between gap-3 text-[11px] tracking-wide">
                      <div className="flex min-w-0 items-center gap-1.5 text-slate-500">
                        <div className="h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                        <span className="truncate">
                          第 {period.periodNumber} 期課程
                          <span className="ml-1 text-[9px] font-normal text-slate-400">({period.totalSessions}堂課)</span>
                        </span>
                      </div>
                      <span className="shrink-0 font-bold text-slate-700">{formatTWD(period.price)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )) : (
              <p className="py-2 text-center text-xs font-semibold text-slate-400">無相關課程明細</p>
            )}
          </div>
        </section>

        {!isOnSite && <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-1.5 border-b border-slate-50 pb-2">
            <span className="h-3 w-1 rounded-full bg-brand-green" />
            <h3 className="text-xs font-bold tracking-wider text-slate-800">轉帳匯款資訊</h3>
          </div>

          <div className="space-y-3.5 rounded-xl border border-slate-100 bg-slate-50/50 p-4">
            <div className="grid grid-cols-1 gap-2 text-xs">
              <div className="flex justify-between gap-3 border-b border-slate-100/70 py-1">
                <span className="shrink-0 font-medium text-slate-400">戶名</span>
                <span className="text-right font-bold text-slate-700">{accountHolder}</span>
              </div>
              <div className="flex justify-between gap-3 border-b border-slate-100/70 py-1">
                <span className="shrink-0 font-medium text-slate-400">銀行 / 分行</span>
                <span className="text-right font-bold text-slate-700">{[bankName, branchName].filter(Boolean).join(' ') || '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-3 py-1">
                <span className="shrink-0 font-medium text-slate-400">轉帳帳號</span>
                <span className="min-w-0 truncate font-mono text-sm font-bold tracking-wide text-slate-900">
                  {accountNumber || '聯絡櫃檯'}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleCopy(accountNumber)}
              disabled={!accountNumber}
              className={`flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition active:scale-[0.98] ${
                !accountNumber
                  ? 'cursor-not-allowed bg-slate-100 text-slate-400'
                  : copied
                    ? 'bg-brand-green text-brand-primary shadow-sm'
                    : 'bg-brand-primary text-white shadow-sm hover:bg-brand-primary/90'
              }`}
            >
              {copied ? (
                <>
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                  已複製轉帳帳號
                </>
              ) : (
                <>
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 0 0 2 2h6M8 7V5a2 2 0 0 1 2-2h4.6L20 8.4V15a2 2 0 0 1-2 2h-2M8 7H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2" />
                  </svg>
                  {accountNumber ? '一鍵複製' : '無帳號資料'}
                </>
              )}
            </button>
          </div>
        </section>}

        {showPaymentForm ? (
          <form onSubmit={handleSubmitPayment} className="space-y-3.5 rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-1.5 border-b border-slate-50 pb-2">
              <span className="h-3 w-1 rounded-full bg-brand-green" />
              <h3 className="text-xs font-bold tracking-wider text-slate-800">回報轉帳證明</h3>
            </div>

            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400" htmlFor="checkout-last5">
                轉帳卡片末 5 碼 <span className="text-brand-error">*</span>
              </label>
              <input
                id="checkout-last5"
                type="tel"
                inputMode="numeric"
                maxLength={5}
                placeholder="請輸入卡片末 5 碼"
                value={transferLast5}
                disabled={proofBusy}
                onChange={(e) => setTransferLast5(e.target.value.replace(/\D/g, '').slice(0, 5))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold tracking-widest transition focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-green/30 disabled:bg-slate-50"
                required
              />
            </div>

            <div>
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">
                上傳轉帳證明截圖 <span className="text-brand-error">*</span>
              </span>
              <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-4 text-center transition hover:border-brand-green/70 hover:bg-white">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-green/15 text-brand-primary">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.6-4.6a2 2 0 0 1 2.8 0L16 16m-2-2 1.6-1.6a2 2 0 0 1 2.8 0L20 14m-6-6h.01M6 20h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" />
                  </svg>
                </div>
                <span className="mt-2 block w-full truncate text-[11px] font-bold tracking-wide text-brand-primary">
                  {proofFile ? proofFile.name : checkout.has_payment_proof ? '舊憑證已保留，點擊更換' : '選擇或拍攝匯款憑證圖片'}
                </span>
                <span className="mt-0.5 text-[9px] text-slate-400">支援 JPG、PNG、WebP、HEIC、HEIF、AVIF</span>
                <input
                  ref={proofInputRef}
                  type="file"
                  accept={PAYMENT_PROOF_ACCEPT}
                  onChange={(e) => handleFileChange(e.target.files?.[0])}
                  className="hidden"
                  disabled={proofBusy}
                />
              </label>

              {proofPreview && (
                <div className="mt-2.5 flex justify-center">
                  <div className="relative max-h-36 overflow-hidden rounded-lg border border-slate-100">
                    <img src={proofPreview} alt="轉帳證明預覽" className="max-h-36 rounded-lg object-contain" />
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400" htmlFor="checkout-carrier">
                電子發票載具條碼 <span className="font-normal text-slate-400">(選填)</span>
              </label>
              <input
                id="checkout-carrier"
                type="text"
                placeholder="例如 /ABC+123"
                value={carrier}
                disabled={proofBusy}
                onChange={(e) => setCarrier(e.target.value.slice(0, 64))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold transition focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-green/30 disabled:bg-slate-50"
              />
              <p className="mt-1 text-[9px] font-medium leading-normal text-slate-400">
                發票將於櫃檯核對款項無誤後，自動開立至載具中。
              </p>
            </div>

            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400" htmlFor="checkout-note">
                備註 <span className="font-normal text-slate-400">(選填)</span>
              </label>
              <textarea
                id="checkout-note"
                rows={2}
                maxLength={500}
                placeholder="例如：分次匯款、末碼有誤說明等，給櫃檯參考"
                value={parentNote}
                disabled={proofBusy}
                onChange={(e) => setParentNote(e.target.value)}
                className="w-full resize-y rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold transition focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-green/30 disabled:bg-slate-50"
              />
            </div>

            <button
              type="submit"
              disabled={submitDisabled}
              className={`flex w-full items-center justify-center rounded-xl py-2.5 text-xs font-bold text-white transition active:scale-[0.98] ${
                submitDisabled ? 'cursor-not-allowed bg-brand-primary/35' : 'bg-brand-primary hover:bg-brand-primary/90'
              }`}
            >
              {proofBusy ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  正傳送對帳資料...
                </span>
              ) : (
                '確認無誤，送出付款資料'
              )}
            </button>
          </form>
        ) : (
          <section className={`rounded-xl border p-5 text-center ${
            checkout.payment_status === 'cancelled'
              ? 'border-slate-200 bg-white'
              : 'border-brand-green/30 bg-brand-green/10'
          }`}
          >
            <div className={`mx-auto flex h-10 w-10 items-center justify-center rounded-full shadow-sm ${
              checkout.payment_status === 'cancelled'
                ? 'bg-slate-100 text-slate-500'
                : 'bg-brand-green/20 text-brand-primary'
            }`}
            >
              {checkout.payment_status === 'cancelled' ? (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
            <h4 className="mt-3.5 text-xs font-extrabold tracking-wide text-brand-primary">{meta.headline}</h4>
            <p className="mt-1.5 text-[11px] font-semibold leading-relaxed text-brand-primary/80">
              {meta.body}
              {checkout.transfer_last_5 && checkout.payment_status !== 'cancelled' && (
                <>
                  <br />
                  已收到末碼 <span className="font-mono font-bold tracking-wider text-brand-primary">{checkout.transfer_last_5}</span> 的付款資料。
                </>
              )}
            </p>
            {checkout.parent_note && checkout.payment_status !== 'cancelled' && (
              <p className="mt-2 whitespace-pre-wrap rounded-lg bg-white/60 p-2 text-left text-[11px] font-medium text-brand-primary/80">
                您的備註：{checkout.parent_note}
              </p>
            )}
            <div className="mt-4 border-t border-brand-green/30 pt-3">
              <button
                type="button"
                onClick={() => navigate('/my-courses', { replace: true })}
                className="text-xs font-bold text-brand-primary underline decoration-dashed underline-offset-4 transition hover:text-brand-primary/80"
              >
                返回我的課程
              </button>
            </div>
          </section>
        )}

        <section className="space-y-1 rounded-xl border border-slate-100 bg-white p-4 text-[10px] font-medium leading-relaxed text-slate-400">
          <p className="font-bold tracking-wide text-slate-500">帳單及轉帳需知：</p>
          <p>{isOnSite ? '1. 此為現場付費試上訂單；完成付款前不會被標記為已付款或開通。' : '1. 完成匯款後，請務必於本頁回填金融卡或網銀轉帳的「卡片末 5 碼」並上傳截圖，以便加速對帳開通。'}</p>
          <p>2. 對於本筆合併帳單或金額明細有任何問題，請在櫃檯對帳開通前直接向場館諮詢。</p>
        </section>

        {canUpload && !hasGroupOrder && !paymentLocked && (
          <div className="flex justify-center pb-2 pt-2">
            <button
              type="button"
              disabled={cancelBusy}
              onClick={handleCancelCheckout}
              className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-xs font-medium text-slate-400 transition hover:text-brand-error active:scale-95 disabled:opacity-50"
            >
              {cancelBusy ? '正在取消報名...' : '取消報名'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
