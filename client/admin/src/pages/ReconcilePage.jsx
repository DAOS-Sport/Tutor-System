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

const EMPTY_FILTERS = {
  submittedFrom: '', submittedTo: '', phone: '', parentName: '', studentName: '',
  coach: '', courseType: '', last5: '',
};

const INVOICE_RE = /^[A-Z]{2}\d{8}$/;

function InvoiceModal({ checkout, canReconcile, onCancel, onDone }) {
  const toast = useToast();
  const { user } = useAuth();
  const fileRef = useRef(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceUrl, setInvoiceUrl] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [busy, onCancel]);

  function handleFile(file) {
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) { toast.error('只接受 JPG / PNG 圖片'); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error('圖片大小不得超過 5MB'); return; }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  const numOk = INVOICE_RE.test(invoiceNumber);
  const canSubmit = numOk && imageFile && !busy && canReconcile;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      setUploading(true);
      const { url: imageUrl } = await enrollmentsApi.uploadInvoice(imageFile);
      setUploading(false);
      await checkoutsApi.reconcile(checkout.checkout_id, {
        by: user.name,
        invoice_number: invoiceNumber,
        invoice_image_url: imageUrl,
        invoice_url: invoiceUrl.trim() || undefined,
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
      <div className="flex w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl" style={{ maxHeight: '90dvh' }}>
        {/* ── 固定 Header ── */}
        <div className="shrink-0 border-b border-gray-100 px-6 pt-5 pb-4">
          <h3 className="text-lg font-bold text-brand-primary">對帳通過 — 輸入發票資訊</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            {checkout.checkout_id} ／ {checkout.parent_name} ／ 應收 {formatTWD(checkout.total_amount)}，末 5 碼 <b>{checkout.transfer_last_5 || '—'}</b>
          </p>
        </div>

        {/* ── 可捲動 Body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {checkout.payment_proof_url && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="mb-2 text-xs font-semibold text-gray-600">家長上傳的匯款／轉帳證明</div>
              <ImageLightbox
                src={checkout.payment_proof_url}
                alt="匯款證明"
                label="匯款／轉帳證明"
              />
            </div>
          )}

          {checkout.carrier && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
              <div className="mb-1 text-xs font-semibold text-indigo-700">載具（開發票掃描用）</div>
              <div className="font-mono text-sm font-bold text-indigo-900">{checkout.carrier}</div>
              <div className="mt-2 inline-block rounded-lg bg-white p-2">
                <Barcode value={checkout.carrier} />
              </div>
            </div>
          )}

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
              <span className="ml-2 font-normal text-gray-400">（JPG / PNG，≤ 5MB）</span>
            </label>
            <div
              className={`relative flex min-h-24 flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 transition ${imageFile ? 'border-brand-teal bg-brand-teal/5' : 'cursor-pointer border-gray-300 hover:border-brand-teal'}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]); }}
              onClick={() => !imageFile && fileRef.current?.click()}
            >
              {imagePreview ? (
                <>
                  <img src={imagePreview} alt="發票預覽" className="max-h-36 rounded-lg object-contain" />
                  <button
                    type="button"
                    className="mt-2 text-xs text-gray-500 underline hover:text-red-500"
                    onClick={(e) => { e.stopPropagation(); setImageFile(null); setImagePreview(null); }}
                  >重新選擇</button>
                </>
              ) : (
                <div className="text-center text-sm text-gray-400">
                  <div className="mb-1 text-3xl">📄</div>
                  <div>拖放或點此選擇發票照片</div>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])} />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">
              發票查詢連結
              <span className="ml-2 font-normal text-gray-400">（選填）</span>
            </label>
            <input
              type="url"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-teal"
              placeholder="https://inv.ezpay.com.tw/..."
              value={invoiceUrl}
              onChange={(e) => setInvoiceUrl(e.target.value)}
            />
          </div>

          <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
            對帳後系統將一次開通此付款單的 {checkout.sub_orders?.length || 0} 筆子訂單，並透過 LINE 推播發票通知給家長。
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
            {uploading ? '上傳中…' : busy ? '處理中…' : '確認對帳'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ReconcilePage() {
  const toast = useToast();
  const { user, isStaff } = useAuth();
  // 對帳改由行政櫃檯處理：staff 亦可對帳（後端 reconcile 已開放 staff）。
  const canReconcile = true;
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [confirming, setConfirming] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [cancelling, setCancelling] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [expanded, setExpanded] = useState({});

  async function load() {
    const venueId = isStaff ? user?.venue_id : undefined;
    const [data, vs] = await Promise.all([
      checkoutsApi.list({ status: 'pending', venueId }),
      venuesApi.list(),
    ]);
    setList(data); setVenues(vs);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const coachOptions = useMemo(() => {
    const names = new Set((list || []).flatMap((r) => (r.sub_orders || []).map((o) => o.coach)).filter(Boolean));
    return [...names].sort().map((name) => ({ value: name, label: name }));
  }, [list]);

  const courseTypeOptions = useMemo(() => {
    const types = new Set((list || []).flatMap((r) => (r.sub_orders || []).map((o) => o.course_type)).filter((t) => t != null));
    return [...types].sort((a, b) => a - b).map((t) => ({ value: String(t), label: courseTypeLabel(t) }));
  }, [list]);

  const filterFields = [
    { key: 'submitted', label: '報名日期', type: 'dateRange' },
    { key: 'phone', label: '行動電話', type: 'input', placeholder: '家長手機' },
    { key: 'parentName', label: '家長姓名', type: 'input' },
    { key: 'studentName', label: '學員姓名', type: 'input' },
    { key: 'coach', label: '教練', type: 'combo', options: coachOptions, placeholder: '可輸入或選擇' },
    { key: 'courseType', label: '組別', type: 'select',
      options: [{ value: '', label: '全部' }, ...courseTypeOptions] },
    { key: 'last5', label: '末五碼', type: 'input', placeholder: '轉帳末 5 碼' },
  ];

  const filteredList = useMemo(() => {
    if (!Array.isArray(list)) return [];
    const phoneQ = filters.phone.trim();
    const parentQ = filters.parentName.trim().toLowerCase();
    const studentQ = filters.studentName.trim().toLowerCase();
    const coachQ = filters.coach.trim().toLowerCase();
    const last5Q = filters.last5.trim();
    return list.filter((r) => {
      if (filters.submittedFrom && (r.submitted_at || '').slice(0, 10) < filters.submittedFrom) return false;
      if (filters.submittedTo && (r.submitted_at || '').slice(0, 10) > filters.submittedTo) return false;
      const orders = r.sub_orders || [];
      if (phoneQ && !(r.parent_phone || '').includes(phoneQ) && !orders.some((o) => (o.parent_phone || '').includes(phoneQ))) return false;
      if (parentQ && !(r.parent_name || '').toLowerCase().includes(parentQ) && !orders.some((o) => (o.parent_name || '').toLowerCase().includes(parentQ))) return false;
      if (studentQ && !orders.some((o) => (o.students || []).some((s) => (s || '').toLowerCase().includes(studentQ)))) return false;
      if (coachQ && !orders.some((o) => (o.coach || '').toLowerCase().includes(coachQ))) return false;
      if (filters.courseType && !orders.some((o) => String(o.course_type) === filters.courseType)) return false;
      if (last5Q && !(r.transfer_last_5 || '').includes(last5Q)) return false;
      return true;
    });
  }, [list, filters]);

  async function handleCancelConfirm() {
    if (!cancelling) return;
    setCancelBusy(true);
    try {
      const updated = await checkoutsApi.cancel(cancelling.checkout_id, { by: user.name });
      setList((prev) => prev.map((r) => (r.checkout_id === cancelling.checkout_id ? { ...r, ...updated } : r)));
      toast.success('已取消此付款單');
      setCancelling(null);
    } catch (err) {
      toast.error(err?.response?.data?.error || '取消失敗');
    } finally {
      setCancelBusy(false);
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
        <button
          type="button"
          className="text-left font-mono text-xs text-brand-primary underline-offset-2 hover:underline"
          onClick={() => setExpanded((prev) => ({ ...prev, [r.checkout_id]: !prev[r.checkout_id] }))}
        >
          {r.checkout_id}
        </button>
      ),
    },
    { key: 'submitted_at', label: '送出時間', render: (r) => <span className="text-xs text-gray-600">{formatTWDateTime(r.submitted_at)}</span> },
    { key: 'parent', label: '家長', render: (r) => <div><div className="font-medium">{r.parent_name}</div><div className="text-xs text-gray-500">{r.parent_phone}</div></div> },
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
                    <div className="mt-0.5 text-gray-500">
                      {order.coach}／{venueName(order.venue_id)}／{courseTypeLabel(order.course_type)}／第 {order.period_number || 1} 期
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
      key: 'proof',
      label: '憑證',
      render: (r) => (r.payment_proof_url ? <StatusBadge tone="amber">已上傳</StatusBadge> : <span className="text-xs text-gray-400">未上傳</span>),
    },
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
            <button className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-bold text-gray-600 hover:bg-gray-100"
              onClick={() => setCancelling(r)}>取消</button>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="待對帳清單"
        subtitle={`F-M02 · 共 ${list.length} 筆等待對帳${isStaff ? '（限本場館）' : ''}`}
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
        open={!!cancelling}
        title="確定取消此筆報名？"
        confirmLabel="確定取消" cancelLabel="返回"
        tone="danger" busy={cancelBusy}
        onConfirm={handleCancelConfirm}
        onCancel={() => setCancelling(null)}
      >
        {cancelling && (
          <>
            {cancelling.parent_name}／{cancelling.sub_orders?.length || 0} 筆子訂單，末 5 碼 {cancelling.transfer_last_5 || '—'}。
            取消後將顯示為「已取消」，此動作無法復原。
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
