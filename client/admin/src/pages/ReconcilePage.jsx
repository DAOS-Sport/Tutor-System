import React, { useEffect, useMemo, useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge, { STATUS_TONE } from '../components/StatusBadge';
import FilterBar from '../components/FilterBar';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { enrollmentsApi } from '../api/enrollments';
import { checkoutsApi } from '../api/checkouts';
import { venuesApi } from '../api/venues';
import { formatTWD, formatTWDateTime, courseTypeLabel } from '../utils/format';
import { exportEnrollmentsCsv, exportEnrollmentsXlsx } from '../utils/csvExport';
import ExportMenu from '../components/ExportMenu';
import Barcode from '../components/Barcode';
import ImageLightbox from '../components/ImageLightbox';
import { isSupportedImageCandidate, RECEIPT_IMAGE_ACCEPT } from '../utils/imagePreview.mjs';

const EMPTY_FILTERS = {
  submittedFrom: '', submittedTo: '', phone: '', parentName: '', studentName: '',
  coach: '', courseType: '', last5: '', venueId: '', orderKind: '',
};

// 試上判斷：母單 order_kind 為主，子訂單任一筆 trial 亦視為試上（防母單欄位缺值的舊資料）。
const isTrialCheckout = (r) => r?.order_kind === 'trial' || (r?.sub_orders || []).some((o) => o.order_kind === 'trial');

const INVOICE_RE = /^[A-Z]{2}\d{8}$/;

// 場館是 checkout 的子訂單資料。優先使用後端提供的穩定 { venue_id, venue_name }
// 契約，舊回應才退回子訂單欄位；不可拿母單第一筆 venue 代表全部子訂單。
function checkoutVenueEntries(checkout) {
  const source = Array.isArray(checkout?.venues) && checkout.venues.length
    ? checkout.venues
    : (checkout?.sub_orders || []);
  const seen = new Set();
  return source
    .map((venue) => {
      const venueId = venue?.venue_id ?? venue?.id;
      if (venueId == null || venueId === '') return null;
      const id = String(venueId);
      if (seen.has(id)) return null;
      seen.add(id);
      return {
        venue_id: id,
        venue_name: venue?.venue_name || venue?.name || id,
      };
    })
    .filter(Boolean);
}

function VenueBadges({ checkout, className = '' }) {
  const entries = checkoutVenueEntries(checkout);
  if (!entries.length) return <span className="text-xs text-gray-400">未綁定場館</span>;
  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {entries.map((venue) => (
        <span
          key={venue.venue_id}
          title={`${venue.venue_name} (${venue.venue_id})`}
          className="inline-flex max-w-[10rem] truncate rounded-full border border-brand-teal/30 bg-brand-teal/10 px-2 py-0.5 text-xs font-medium text-brand-primary"
        >
          {venue.venue_name}
        </span>
      ))}
    </div>
  );
}

function checkoutProofUrls(checkout) {
  const candidates = Array.isArray(checkout?.payment_proof_urls)
    ? checkout.payment_proof_urls
    : [checkout?.payment_proof_url];
  return [...new Set(candidates.map((value) => String(value || '').trim()).filter(Boolean))];
}

function checkoutInvoiceFamilies(checkout) {
  const serverFamilies = Array.isArray(checkout?.invoice_families)
    ? checkout.invoice_families.filter((family) => family?.family_key)
    : [];
  if (serverFamilies.length) return serverFamilies;

  // 舊 API 回應相容：沒有家庭摘要時仍只走原本的一張發票流程，不在前端猜跨戶。
  const orders = checkout?.sub_orders || [];
  return [{
    family_key: `checkout:${checkout?.checkout_id || 'legacy'}`,
    parent_name: checkout?.parent_name || orders[0]?.parent_name || null,
    parent_phone: checkout?.parent_phone || orders[0]?.parent_phone || null,
    carrier: checkout?.carrier || orders[0]?.carrier || '',
    amount: Number(checkout?.total_amount) || 0,
    order_ids: orders.map((order) => order.id).filter(Boolean),
    order_count: orders.length,
    payment_proof_urls: checkoutProofUrls(checkout),
  }];
}

function ordersForInvoiceFamily(checkout, family) {
  const ids = new Set(Array.isArray(family?.order_ids) ? family.order_ids.map(String) : []);
  return (checkout?.sub_orders || []).filter((order) => ids.has(String(order.id)));
}

function validateInvoiceImage(file, toast) {
  if (!file) return false;
  if (!isSupportedImageCandidate(file)) {
    toast.error('請選擇 JPG、PNG、WebP、HEIC、HEIF 或 AVIF 圖片');
    return false;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast.error('圖片大小不得超過 5MB');
    return false;
  }
  return true;
}

function FamilyInvoiceFields({ family, familyIndex, orders, value, onChange, busy, toast }) {
  const fileRef = useRef(null);
  const numOk = INVOICE_RE.test(value.invoiceNumber);
  const familyProofs = Array.isArray(family.payment_proof_urls)
    ? family.payment_proof_urls.filter(Boolean)
    : [];

  function handleFile(file) {
    if (!validateInvoiceImage(file, toast)) return;
    onChange('imageFile', file);
  }

  return (
    <section className="overflow-hidden rounded-xl border-2 border-brand-teal/30 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 bg-brand-teal/10 px-4 py-3">
        <div>
          <div className="text-sm font-bold text-brand-primary">
            家庭 {familyIndex + 1}：{family.parent_name || '未命名家長'}
          </div>
          <div className="mt-0.5 text-xs text-gray-600">
            帳號手機 {family.parent_phone || '未提供（系統已採保守獨立歸戶）'}・{orders.length} 筆子訂單
          </div>
        </div>
        <div className="rounded-full bg-white px-3 py-1 font-mono text-sm font-bold text-brand-primary shadow-sm">
          應開 {formatTWD(family.amount)}
        </div>
      </div>

      <div className="space-y-4 p-4">
        {familyProofs.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-semibold text-gray-600">此家庭的匯款／轉帳證明</div>
            <div className="flex flex-wrap gap-2">
              {familyProofs.map((url, index) => (
                <ImageLightbox
                  key={url}
                  src={url}
                  alt={`家庭 ${familyIndex + 1} 匯款證明 ${index + 1}`}
                  label={`家庭 ${familyIndex + 1} 匯款／轉帳證明 ${index + 1}`}
                />
              ))}
            </div>
          </div>
        )}

        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="mb-2 text-xs font-semibold text-gray-600">此家庭的發票品項</div>
          <div className="space-y-2">
            {orders.map((order) => (
              <div key={order.id} className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium text-gray-800">{order.id}・{(order.students || []).join('、') || '—'}</div>
                  <div className="mt-0.5 text-xs text-gray-500">{order.coach}・{courseTypeLabel(order.course_type)}・第 {order.period_number || 1} 期</div>
                </div>
                <div className="shrink-0 font-mono font-bold">{formatTWD(order.final_price)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
          <label className="mb-1 block text-xs font-semibold text-indigo-700" htmlFor={`family-carrier-${familyIndex}`}>
            此家庭電子發票載具（選填，可直接用掃描器刷入）
          </label>
          <input
            id={`family-carrier-${familyIndex}`}
            type="text"
            maxLength={64}
            value={value.carrier}
            disabled={busy}
            onChange={(e) => onChange('carrier', e.target.value.slice(0, 64))}
            placeholder="例如 /ABC+123"
            className="w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 font-mono text-sm text-indigo-900 focus:border-brand-teal focus:outline-none disabled:bg-gray-100"
          />
          {value.carrier && (
            <div className="mt-2 inline-block rounded-lg bg-white p-2">
              <Barcode value={value.carrier} />
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-semibold text-gray-700" htmlFor={`family-invoice-number-${familyIndex}`}>
            此家庭發票號碼 <span className="text-red-500">*</span>
          </label>
          <input
            id={`family-invoice-number-${familyIndex}`}
            type="text"
            maxLength={10}
            disabled={busy}
            className={`w-full rounded-lg border px-3 py-2 font-mono text-sm uppercase tracking-widest focus:outline-none focus:ring-2 ${numOk || !value.invoiceNumber ? 'border-gray-300 focus:ring-brand-teal' : 'border-red-400 focus:ring-red-400'}`}
            placeholder="AA00000000"
            value={value.invoiceNumber}
            onChange={(e) => onChange('invoiceNumber', e.target.value.toUpperCase())}
          />
          {value.invoiceNumber && !numOk && (
            <p className="mt-1 text-xs text-red-500">格式：2 大寫英文 + 8 數字，例如 AB12345678</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-semibold text-gray-700">
            此家庭發票照片 <span className="text-red-500">*</span>
            <span className="ml-2 font-normal text-gray-400">（JPG / PNG / WebP / HEIC / HEIF / AVIF，≤ 5MB）</span>
          </label>
          <div
            className={`relative flex min-h-24 flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 transition ${value.imageFile ? 'border-brand-teal bg-brand-teal/5' : 'cursor-pointer border-gray-300 hover:border-brand-teal'}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]); }}
            onClick={() => !value.imageFile && fileRef.current?.click()}
          >
            {value.imageFile ? (
              <>
                <ImageLightbox
                  src={value.imageFile}
                  alt={`家庭 ${familyIndex + 1} 發票預覽`}
                  label={`家庭 ${familyIndex + 1} 新選擇的發票照片`}
                  fileName={value.imageFile.name}
                  thumbnailClassName="h-36 w-full max-w-sm"
                  onRetry={() => fileRef.current?.click()}
                />
                <button
                  type="button"
                  disabled={busy}
                  className="mt-2 text-xs text-gray-500 underline hover:text-red-500"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange('imageFile', null);
                    if (fileRef.current) fileRef.current.value = '';
                  }}
                >重新選擇</button>
              </>
            ) : (
              <div className="text-center text-sm text-gray-400">
                <div className="mb-1 text-3xl">📄</div>
                <div>拖放或點此選擇此家庭的發票照片</div>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept={RECEIPT_IMAGE_ACCEPT}
              className="hidden"
              disabled={busy}
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </div>
        </div>

      </div>
    </section>
  );
}

function InvoiceModal({ checkout, canReconcile, onCancel, onDone }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const invoiceFamilies = useMemo(() => checkoutInvoiceFamilies(checkout), [checkout]);
  const multiFamily = invoiceFamilies.length > 1;
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [carrier, setCarrier] = useState(checkout.carrier || '');
  const [note, setNote] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [familyForms, setFamilyForms] = useState(() => Object.fromEntries(
    checkoutInvoiceFamilies(checkout).map((family) => [family.family_key, {
      invoiceNumber: '',
      carrier: family.carrier || '',
      imageFile: null,
    }])
  ));
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const paymentProofUrls = checkoutProofUrls(checkout);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [busy, onCancel]);

  function handleFile(file) {
    if (!validateInvoiceImage(file, toast)) return;
    setImageFile(file);
  }

  function updateFamilyForm(familyKey, field, value) {
    setFamilyForms((previous) => ({
      ...previous,
      [familyKey]: { ...previous[familyKey], [field]: value },
    }));
  }

  const numOk = INVOICE_RE.test(invoiceNumber);
  const familyNumbers = invoiceFamilies.map((family) => familyForms[family.family_key]?.invoiceNumber || '');
  const familyFormsOk = invoiceFamilies.every((family) => {
    const form = familyForms[family.family_key];
    return form && INVOICE_RE.test(form.invoiceNumber) && form.imageFile;
  }) && new Set(familyNumbers).size === familyNumbers.length;
  const canSubmit = (multiFamily ? familyFormsOk : (numOk && imageFile)) && !busy && canReconcile;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      setUploading(true);
      if (multiFamily) {
        const uploadedFamilies = await Promise.all(invoiceFamilies.map(async (family) => {
          const form = familyForms[family.family_key];
          const uploaded = await enrollmentsApi.uploadInvoice(form.imageFile);
          return { family, form, uploaded };
        }));
        setUploading(false);
        if (uploadedFamilies.some(({ uploaded }) => uploaded.conversion_status === 'pending')) {
          toast.warning('原始圖片已保存，部分預覽轉檔處理中；本次對帳仍可繼續');
        }
        await checkoutsApi.reconcile(checkout.checkout_id, {
          family_invoices: uploadedFamilies.map(({ family, form, uploaded }) => ({
            family_key: family.family_key,
            invoice_number: form.invoiceNumber,
            invoice_image_url: uploaded.preview_url || uploaded.url,
            carrier: form.carrier.trim() || undefined,
          })),
          note: note.trim() || undefined,
        });
        toast.success(`對帳通過，已依 ${invoiceFamilies.length} 個家庭記錄 ${invoiceFamilies.length} 張發票並分別推播`);
        onDone();
        return;
      }

      const uploaded = await enrollmentsApi.uploadInvoice(imageFile);
      const imageUrl = uploaded.preview_url || uploaded.url;
      setUploading(false);
      if (uploaded.conversion_status === 'pending') {
        toast.warning('原始圖片已保存，預覽轉檔處理中；本次對帳仍可繼續');
      }
      await checkoutsApi.reconcile(checkout.checkout_id, {
        invoice_number: invoiceNumber,
        invoice_image_url: imageUrl,
        carrier: carrier.trim() || undefined,
        note: note.trim() || undefined,
      });
      toast.success(`對帳通過，發票 ${invoiceNumber} 已記錄並推播家長`);
      onDone();
    } catch (err) {
      setUploading(false);
      toast.error(err?.response?.data?.error || '對帳失敗');
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}
      role="dialog" aria-modal="true" aria-label="對帳通過 — 輸入發票資訊"
    >
      <div className={`flex w-full ${multiFamily ? 'max-w-3xl' : 'max-w-lg'} flex-col rounded-2xl bg-white shadow-xl`} style={{ maxHeight: '90dvh' }}>
        {/* ── 固定 Header ── */}
        <div className="shrink-0 border-b border-gray-100 px-6 pt-5 pb-4">
          <h3 className="text-lg font-bold text-brand-primary">對帳通過 — 輸入發票資訊</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            {checkout.checkout_id} ／ {multiFamily ? `${invoiceFamilies.length} 個家庭` : checkout.parent_name} ／ 應收 {formatTWD(checkout.total_amount)}，末 5 碼 <b>{checkout.transfer_last_5 || '—'}</b>
          </p>
        </div>

        {/* ── 可捲動 Body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {checkout.parent_note && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
              <div className="mb-1 text-xs font-semibold text-indigo-700">家長備註</div>
              <p className="whitespace-pre-wrap text-sm text-indigo-900">{checkout.parent_note}</p>
            </div>
          )}

          {paymentProofUrls.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="mb-2 text-xs font-semibold text-gray-600">家長上傳的匯款／轉帳證明</div>
              <div className="flex flex-wrap gap-2">
                {paymentProofUrls.map((url, index) => (
                  <ImageLightbox
                    key={url}
                    src={url}
                    alt={`匯款證明 ${index + 1}`}
                    label={`匯款／轉帳證明 ${index + 1}`}
                  />
                ))}
              </div>
            </div>
          )}

          {multiFamily ? (
            <>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                <div className="font-bold">此付款單包含 {invoiceFamilies.length} 個不同家庭，需分別開立 {invoiceFamilies.length} 張發票。</div>
                <div className="mt-1 text-xs">系統已依家長帳號歸戶品項與金額；每戶的發票號碼、照片及載具皆獨立保存。</div>
              </div>
              {invoiceFamilies.map((family, index) => (
                <FamilyInvoiceFields
                  key={family.family_key}
                  family={family}
                  familyIndex={index}
                  orders={ordersForInvoiceFamily(checkout, family)}
                  value={familyForms[family.family_key]}
                  onChange={(field, value) => updateFamilyForm(family.family_key, field, value)}
                  busy={busy}
                  toast={toast}
                />
              ))}
              {familyNumbers.some(Boolean) && new Set(familyNumbers.filter(Boolean)).size !== familyNumbers.filter(Boolean).length && (
                <p className="text-xs font-medium text-red-600">不同家庭不可填寫相同的發票號碼。</p>
              )}
            </>
          ) : (
            <>
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
            <label className="mb-1 block text-xs font-semibold text-indigo-700" htmlFor="reconcile-carrier">
              電子發票載具（選填，可直接用掃描器刷入）
            </label>
            <input
              id="reconcile-carrier"
              type="text"
              maxLength={64}
              value={carrier}
              disabled={busy}
              onChange={(e) => setCarrier(e.target.value.slice(0, 64))}
              placeholder="例如 /ABC+123；舊團購可在此補刷"
              className="w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 font-mono text-sm text-indigo-900 focus:border-brand-teal focus:outline-none disabled:bg-gray-100"
            />
            {carrier && (
              <div className="mt-2 inline-block rounded-lg bg-white p-2">
                <Barcode value={carrier} />
              </div>
            )}
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="mb-2 text-xs font-semibold text-gray-600">發票品項</div>
            <div className="space-y-2">
              {(checkout.sub_orders || []).map((order) => (
                <div key={order.id} className="flex items-center justify-between gap-3 rounded-md bg-gray-50 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-gray-800">{order.id}・{(order.students || []).join('、') || '—'}</div>
                    <div className="mt-0.5 text-xs text-gray-500">{order.coach}・{courseTypeLabel(order.course_type)}・第 {order.period_number || 1} 期</div>
                  </div>
                  <div className="shrink-0 font-mono font-bold">{formatTWD(order.final_price)}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">
              發票號碼 <span className="text-red-500">*</span>
            </label>
            <input
              type="text" maxLength={10}
              className={`w-full rounded-lg border px-3 py-2 font-mono text-sm uppercase tracking-widest focus:outline-none focus:ring-2 ${numOk || !invoiceNumber ? 'border-gray-300 focus:ring-brand-teal' : 'border-red-400 focus:ring-red-400'}`}
              placeholder="AA00000000"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value.toUpperCase())}
            />
            {invoiceNumber && !numOk && (
              <p className="mt-1 text-xs text-red-500">格式：2 大寫英文 + 8 數字，例如 AB12345678</p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">
              發票照片 <span className="text-red-500">*</span>
              <span className="ml-2 font-normal text-gray-400">（JPG / PNG / WebP / HEIC / HEIF / AVIF，≤ 5MB）</span>
            </label>
            <div
              className={`relative flex min-h-24 flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 transition ${imageFile ? 'border-brand-teal bg-brand-teal/5' : 'cursor-pointer border-gray-300 hover:border-brand-teal'}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]); }}
              onClick={() => !imageFile && fileRef.current?.click()}
            >
              {imageFile ? (
                <>
                  <ImageLightbox
                    src={imageFile}
                    alt="發票預覽"
                    label="新選擇的發票照片"
                    fileName={imageFile.name}
                    thumbnailClassName="h-36 w-full max-w-sm"
                    onRetry={() => fileRef.current?.click()}
                  />
                  <button
                    type="button"
                    className="mt-2 text-xs text-gray-500 underline hover:text-red-500"
                    onClick={(e) => { e.stopPropagation(); setImageFile(null); if (fileRef.current) fileRef.current.value = ''; }}
                  >重新選擇</button>
                </>
              ) : (
                <div className="text-center text-sm text-gray-400">
                  <div className="mb-1 text-3xl">📄</div>
                  <div>拖放或點此選擇發票照片</div>
                </div>
              )}
              <input ref={fileRef} type="file" accept={RECEIPT_IMAGE_ACCEPT} className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])} />
            </div>
          </div>

            </>
          )}

          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700" htmlFor="reconcile-note">
              備註
              <span className="ml-2 font-normal text-gray-400">（選填，僅供內部稽核紀錄查閱）</span>
            </label>
            <textarea
              id="reconcile-note"
              value={note}
              maxLength={500}
              rows={2}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：家長來電補充說明、對帳異常處理方式"
              className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none disabled:bg-gray-100"
            />
          </div>

          <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
            {multiFamily
              ? `對帳後系統將一次開通此付款單的 ${checkout.sub_orders?.length || 0} 筆子訂單，並依家庭分別保存及推播各自的發票。`
              : `對帳後系統將一次開通此付款單的 ${checkout.sub_orders?.length || 0} 筆子訂單，並透過 LINE 推播發票通知給家長。`}
          </div>
        </div>

        {/* ── 固定 Footer ── */}
        <div className="shrink-0 flex justify-end gap-3 border-t border-gray-100 px-6 py-4">
          <button type="button" disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            onClick={onCancel}>取消</button>
          <button type="button" disabled={!canSubmit}
            className="rounded-lg bg-brand-green px-4 py-2 text-sm font-bold text-white hover:bg-brand-teal disabled:opacity-50"
            onClick={handleSubmit}>
            {uploading ? '上傳中…' : busy ? '處理中…' : multiFamily ? `確認 ${invoiceFamilies.length} 張發票並對帳` : '確認對帳'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ReconcilePage() {
  const toast = useToast();
  const { isAdmin, venueIds } = useAuth();
  // 對帳改由行政櫃檯處理：staff 亦可對帳（後端 reconcile 已開放 staff）。
  const canReconcile = true;
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [confirming, setConfirming] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [cancelling, setCancelling] = useState(null);
  // U14 退回補件：與「取消付款單」並存。多數退回其實只是付款資料填錯，
  // 用取消會讓家長得從頭報名一次。
  const [returning, setReturning] = useState(null);
  const [returnReason, setReturnReason] = useState('');
  const [returnBusy, setReturnBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [expanded, setExpanded] = useState({});
  const loadVersionRef = useRef(0);

  async function load(venueId = filters.venueId) {
    const loadVersion = ++loadVersionRef.current;
    try {
      // 場館篩選送進 API；後端仍以 token venue_ids 交集裁判，不能只相信前端下拉選單。
      const [data, vs] = await Promise.all([
        checkoutsApi.list({ status: 'pending', venueId: venueId || undefined }),
        venuesApi.list(),
      ]);
      // 場館下拉快速切換時，舊請求不可覆蓋較新的篩選結果。
      if (loadVersion !== loadVersionRef.current) return;
      setList(Array.isArray(data) ? data : []);
      setVenues(Array.isArray(vs) ? vs : []);
    } catch (err) {
      if (loadVersion !== loadVersionRef.current) return;
      setList([]);
      setVenues([]);
      toast.error(err?.response?.data?.error || '載入待對帳清單失敗');
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters.venueId]);

  const coachOptions = useMemo(() => {
    const names = new Set((list || []).flatMap((r) => (r.sub_orders || []).map((o) => o.coach)).filter(Boolean));
    return [...names].sort().map((name) => ({ value: name, label: name }));
  }, [list]);

  const courseTypeOptions = useMemo(() => {
    const types = new Set((list || []).flatMap((r) => (r.sub_orders || []).map((o) => o.course_type)).filter((t) => t != null));
    return [...types].sort((a, b) => a - b).map((t) => ({ value: String(t), label: courseTypeLabel(t) }));
  }, [list]);

  const isVenueScoped = !isAdmin;
  const venueOptions = useMemo(() => {
    const allowed = isVenueScoped
      ? venues.filter((venue) => venueIds.map(String).includes(String(venue.id)))
      : venues;
    return [
      { value: '', label: isVenueScoped ? '全部（我的場館）' : '全部場館' },
      ...allowed.map((venue) => ({ value: String(venue.id), label: venue.name || venue.id })),
    ];
  }, [venues, isVenueScoped, venueIds]);

  const filterFields = [
    { key: 'submitted', label: '報名日期', type: 'dateRange' },
    { key: 'phone', label: '行動電話', type: 'input', placeholder: '家長手機' },
    { key: 'parentName', label: '家長姓名', type: 'input' },
    { key: 'studentName', label: '學員姓名', type: 'input' },
    { key: 'coach', label: '教練', type: 'combo', options: coachOptions, placeholder: '可輸入或選擇' },
    { key: 'courseType', label: '組別', type: 'select',
      options: [{ value: '', label: '全部' }, ...courseTypeOptions] },
    { key: 'venueId', label: '場館', type: 'select', options: venueOptions },
    { key: 'last5', label: '末五碼', type: 'input', placeholder: '轉帳末 5 碼' },
    { key: 'orderKind', label: '訂單類型', type: 'select',
      options: [{ value: '', label: '全部' }, { value: 'trial', label: '試上' }, { value: 'standard', label: '一般' }] },
  ];

  const filteredList = useMemo(() => {
    if (!Array.isArray(list)) return [];
    const phoneQ = filters.phone.trim();
    const parentQ = filters.parentName.trim().toLowerCase();
    const studentQ = filters.studentName.trim().toLowerCase();
    const coachQ = filters.coach.trim().toLowerCase();
    const last5Q = filters.last5.trim();
    const venueQ = filters.venueId;
    return list.filter((r) => {
      if (filters.submittedFrom && (r.submitted_at || '').slice(0, 10) < filters.submittedFrom) return false;
      if (filters.submittedTo && (r.submitted_at || '').slice(0, 10) > filters.submittedTo) return false;
      const orders = r.sub_orders || [];
      if (phoneQ && !(r.parent_phone || '').includes(phoneQ) && !orders.some((o) => (o.parent_phone || '').includes(phoneQ))) return false;
      if (parentQ && !(r.parent_name || '').toLowerCase().includes(parentQ) && !orders.some((o) => (o.parent_name || '').toLowerCase().includes(parentQ))) return false;
      if (studentQ && !orders.some((o) => (o.students || []).some((s) => (s || '').toLowerCase().includes(studentQ)))) return false;
      if (coachQ && !orders.some((o) => (o.coach || '').toLowerCase().includes(coachQ))) return false;
      if (filters.courseType && !orders.some((o) => String(o.course_type) === filters.courseType)) return false;
      if (venueQ && !checkoutVenueEntries(r).some((venue) => venue.venue_id === venueQ)) return false;
      if (last5Q && !(r.transfer_last_5 || '').includes(last5Q)) return false;
      if (filters.orderKind === 'trial' && !isTrialCheckout(r)) return false;
      if (filters.orderKind === 'standard' && isTrialCheckout(r)) return false;
      return true;
    });
  }, [list, filters]);

  async function handleCancelConfirm() {
    if (!cancelling) return;
    const reason = cancelReason.trim();
    if (!reason) { toast.warning('請填寫取消原因'); return; }
    setCancelBusy(true);
    try {
      await checkoutsApi.cancel(cancelling.checkout_id, { reason });
      // 僅在 API 成功後才移除；失敗時保留原列，避免前端假裝取消成功。
      setList((prev) => (prev || []).filter((row) => row.checkout_id !== cancelling.checkout_id));
      toast.success('已取消此付款單');
      setCancelling(null);
      setCancelReason('');
    } catch (err) {
      toast.error(err?.response?.data?.error || '取消失敗');
    } finally {
      setCancelBusy(false);
    }
  }

  async function handleReturnConfirm() {
    if (!returning) return;
    const reason = returnReason.trim();
    if (!reason) { toast.warning('請填寫退回原因'); return; }
    // 後端以單筆 enrollment 為入口，但有 checkout_id 時會一併退回整張 checkout 的付款狀態，
    // 與家長端 payment-proof 的 checkout 層級語意一致，故傳第一筆子訂單即可。
    const firstId = returning.sub_orders?.[0]?.id;
    if (!firstId) { toast.error('此付款單沒有可退回的子訂單'); return; }
    setReturnBusy(true);
    try {
      await enrollmentsApi.returnForFix(firstId, reason);
      toast.success('已退回補件，家長可重新填寫付款資料');
      setReturning(null);
      setReturnReason('');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || '退回補件失敗');
    } finally {
      setReturnBusy(false);
    }
  }

  if (!list) return <LoadingSpinner fullPage />;

  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;

  const exportRows = (list || []).flatMap((checkout) => (
    (checkout.sub_orders || []).map((order) => ({
      ...order,
      parent_name: checkout.parent_name || order.parent_name,
      parent_phone: checkout.parent_phone || order.parent_phone,
      transfer_last_5: checkout.transfer_last_5 || order.transfer_last_5,
      payment_proof_url: checkout.payment_proof_url || order.payment_proof_url,
    }))
  ));

  const columns = [
    {
      key: 'checkout_id',
      label: 'Checkout_ID',
      render: (r) => (
        <div className="min-w-[132px]">
          <button
            type="button"
            className="text-left font-mono text-xs text-brand-primary underline-offset-2 hover:underline"
            onClick={() => setExpanded((prev) => ({ ...prev, [r.checkout_id]: !prev[r.checkout_id] }))}
          >
            {r.checkout_id}
          </button>
          {/* 窄螢幕橫向表格時，仍在第一欄呈現館別，不能只藏在右側欄位。 */}
          <VenueBadges checkout={r} className="mt-1 md:hidden" />
        </div>
      ),
    },
    {
      key: 'venues',
      label: '場館',
      render: (r) => <VenueBadges checkout={r} />,
    },
    { key: 'submitted_at', label: '送出時間', render: (r) => <span className="text-xs text-gray-600">{formatTWDateTime(r.submitted_at)}</span> },
    {
      key: 'parent',
      label: '家長',
      render: (r) => (
        <div>
          <div className="font-medium">{r.requires_separate_invoices ? `${r.family_count} 個家庭` : r.parent_name}</div>
          <div className="text-xs text-gray-500">{r.requires_separate_invoices ? '需分開立發票' : r.parent_phone}</div>
          {isTrialCheckout(r) && (
            <span className="mt-1 inline-flex rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-[11px] font-bold text-teal-700">
              試上{r.payment_method === 'on_site' ? '・現場付費' : ''}
            </span>
          )}
          {r.requires_separate_invoices && (
            <span className="mt-1 inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">
              {r.family_count} 張家庭發票
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'sub_orders',
      label: '子訂單',
      render: (r) => {
        const open = !!expanded[r.checkout_id];
        const orders = r.sub_orders || [];
        return (
          <div className="min-w-[260px]">
            <button
              type="button"
              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-bold text-gray-700 hover:bg-gray-50"
              onClick={() => setExpanded((prev) => ({ ...prev, [r.checkout_id]: !prev[r.checkout_id] }))}
            >
              {open ? '收合' : '展開'} {orders.length} 筆
            </button>
            {open && (
              <div className="mt-2 space-y-2">
                {orders.map((order) => (
                  <div key={order.id} className="rounded-md bg-gray-50 p-2 text-xs text-gray-700">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-gray-500">{order.id}</span>
                      <span className="font-mono font-bold text-brand-primary">{formatTWD(order.final_price)}</span>
                    </div>
                    <div className="mt-1">{(order.students || []).join('、') || '—'}</div>
                    {r.requires_separate_invoices && (
                      <div className="mt-0.5 font-medium text-amber-700">
                        發票歸戶：{order.parent_name || '未命名家長'}／{order.parent_phone || '未提供手機'}
                      </div>
                    )}
                    <div className="mt-0.5 text-gray-500">
                      {order.coach}／{order.venue_name || venueName(order.venue_id)}／{courseTypeLabel(order.course_type)}／第 {order.period_number || 1} 期
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      },
    },
    { key: 'total_amount', label: '應收總額', className: 'text-right', render: (r) => <span className="font-mono">{formatTWD(r.total_amount)}</span> },
    { key: 'transfer_last_5', label: '末 5 碼', className: 'text-center', render: (r) => <span className="font-mono">{r.transfer_last_5}</span> },
    {
      key: 'actions', label: '操作', className: 'text-right',
      render: (r) => {
        if (r.payment_status === 'cancelled') {
          return <StatusBadge tone={STATUS_TONE.cancelled}>已取消</StatusBadge>;
        }
        if (!canReconcile) {
          return <span className="text-xs text-gray-400" title="僅主管 / 管理員可對帳">唯讀</span>;
        }
        return (
          <div className="flex justify-end gap-2">
            <button className="rounded-md bg-brand-green px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-teal"
              onClick={() => setConfirming(r)}>對帳通過</button>
            <button className="rounded-md border border-amber-400 px-3 py-1.5 text-xs font-bold text-amber-600 hover:bg-amber-50"
              title="退回讓家長補正付款資料，訂單保留、不需重新報名"
              onClick={() => { setReturnReason(''); setReturning(r); }}>退回補件</button>
            <button className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-bold text-gray-600 hover:bg-gray-100"
              onClick={() => { setCancelReason(''); setCancelling(r); }}>取消</button>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="待對帳清單"
        subtitle={`F-M02 · 共 ${list.length} 筆等待對帳${isVenueScoped ? '（限您管轄的場館）' : ''}`}
        actions={
          <ExportMenu
            disabled={!list || list.length === 0}
            onExportCsv={() => {
              if (!list || list.length === 0) { toast.error('沒有可匯出的資料'); return; }
              exportEnrollmentsCsv({ filenamePrefix: 'reconcile', enrollments: exportRows, venueName });
              toast.success(`已匯出 ${exportRows.length} 筆子訂單資料 (CSV)`);
            }}
            onExportXlsx={() => {
              if (!list || list.length === 0) { toast.error('沒有可匯出的資料'); return; }
              exportEnrollmentsXlsx({ filenamePrefix: 'reconcile', enrollments: exportRows, venueName });
              toast.success(`已匯出 ${exportRows.length} 筆子訂單資料 (XLSX)`);
            }}
          />
        }
      />
      <FilterBar fields={filterFields} values={filters} onChange={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} />
      <DataTable columns={columns} rows={filteredList} rowKey={(r) => r.checkout_id} empty="目前沒有符合條件的待對帳付款單" />
      {confirming && (
        <InvoiceModal
          checkout={confirming}
          canReconcile={canReconcile}
          onCancel={() => setConfirming(null)}
          onDone={() => { setConfirming(null); load(); }}
        />
      )}
      <ConfirmDialog
        open={!!returning}
        title="退回補件？"
        confirmLabel="確定退回補件" cancelLabel="返回"
        busy={returnBusy} confirmDisabled={!returnReason.trim()}
        onConfirm={handleReturnConfirm}
        onCancel={() => {
          if (returnBusy) return;
          setReturning(null);
          setReturnReason('');
        }}
      >
        {returning && (
          <div className="space-y-3">
            <p>
              {returning.parent_name}／{returning.sub_orders?.length || 0} 筆子訂單，末 5 碼 {returning.transfer_last_5 || '—'}。
              退回後訂單<strong>保留</strong>並回到「待繳款」，原本的末 5 碼與匯款證明會清空供家長重填，
              家長會收到 LINE 通知看到下方原因。不需要重新報名。
            </p>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-gray-700">退回原因 <span className="text-brand-error">*</span></span>
              <textarea
                value={returnReason}
                maxLength={500}
                rows={3}
                disabled={returnBusy}
                onChange={(e) => setReturnReason(e.target.value)}
                placeholder="例如：轉帳末 5 碼與帳戶紀錄不符，請重新確認後填寫"
                className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none disabled:bg-gray-100"
              />
            </label>
          </div>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!cancelling}
        title="確定取消此筆付款單？"
        confirmLabel="確定取消" cancelLabel="返回"
        tone="danger" busy={cancelBusy} confirmDisabled={!cancelReason.trim()}
        onConfirm={handleCancelConfirm}
        onCancel={() => {
          if (cancelBusy) return;
          setCancelling(null);
          setCancelReason('');
        }}
      >
        {cancelling && (
          <div className="space-y-3">
            <p>
              {cancelling.parent_name}／{cancelling.sub_orders?.length || 0} 筆子訂單，末 5 碼 {cancelling.transfer_last_5 || '—'}。
              取消後會從待對帳清單移除，仍可在「所有報名」的已取消篩選中追查。
            </p>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-gray-700">取消原因 <span className="text-brand-error">*</span></span>
              <textarea
                value={cancelReason}
                maxLength={500}
                rows={3}
                disabled={cancelBusy}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="請記錄取消原因（最多 500 字）"
                className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none disabled:bg-gray-100"
              />
            </label>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
