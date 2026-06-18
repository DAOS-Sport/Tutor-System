import React, { useEffect, useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { enrollmentsApi } from '../api/enrollments';
import { venuesApi } from '../api/venues';
import { formatTWD, formatTWDateTime, courseTypeLabel } from '../utils/format';
import { exportEnrollmentsCsv, exportEnrollmentsXlsx } from '../utils/csvExport';
import ExportMenu from '../components/ExportMenu';
import Barcode from '../components/Barcode';

const INVOICE_RE = /^[A-Z]{2}\d{8}$/;

function InvoiceModal({ enrollment, canReconcile, onCancel, onDone }) {
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
      await enrollmentsApi.reconcile(enrollment.id, {
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
            {enrollment.id} ／ {enrollment.parent_name} ／ 應收 {formatTWD(enrollment.final_price)}，末 5 碼 <b>{enrollment.transfer_last_5}</b>
          </p>
        </div>

        {/* ── 可捲動 Body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {enrollment.payment_proof_url && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="mb-2 text-xs font-semibold text-gray-600">家長上傳的匯款／轉帳證明</div>
              <a href={enrollment.payment_proof_url} target="_blank" rel="noreferrer">
                <img
                  src={enrollment.payment_proof_url}
                  alt="匯款證明"
                  className="max-h-40 rounded-lg border border-gray-200 object-contain"
                />
              </a>
              <div className="mt-1 text-[11px] text-gray-400">點圖可放大檢視</div>
            </div>
          )}

          {enrollment.carrier && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
              <div className="mb-1 text-xs font-semibold text-indigo-700">📱 載具（開發票掃描用）</div>
              <div className="font-mono text-sm font-bold text-indigo-900">{enrollment.carrier}</div>
              <div className="mt-2 inline-block rounded-lg bg-white p-2">
                <Barcode value={enrollment.carrier} />
              </div>
            </div>
          )}

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
            對帳後系統將開通 {enrollment.coach} 教練的課程，並透過 LINE 推播發票通知給家長。
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

  async function load() {
    const venueId = isStaff ? user?.venue_id : undefined;
    const [data, vs] = await Promise.all([
      enrollmentsApi.list({ status: 'pending_payment', venueId }),
      venuesApi.list(),
    ]);
    setList(data); setVenues(vs);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  if (!list) return <LoadingSpinner fullPage />;

  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;

  const columns = [
    { key: 'id', label: '報名編號', render: (r) => <span className="font-mono text-xs">{r.id}</span> },
    { key: 'submitted_at', label: '送出時間', render: (r) => <span className="text-xs text-gray-600">{formatTWDateTime(r.submitted_at)}</span> },
    { key: 'parent', label: '家長', render: (r) => <div><div className="font-medium">{r.parent_name}</div><div className="text-xs text-gray-500">{r.parent_phone}</div></div> },
    { key: 'students', label: '學員', render: (r) => <span className="text-sm">{r.students.join('、')}</span> },
    { key: 'coach', label: '教練 / 場館', render: (r) => <div><div>{r.coach}</div><div className="text-xs text-gray-500">{venueName(r.venue_id)}</div></div> },
    { key: 'course_type', label: '組別', render: (r) => <StatusBadge tone="teal">{courseTypeLabel(r.course_type)}</StatusBadge> },
    { key: 'final_price', label: '應收', className: 'text-right', render: (r) => <span className="font-mono">{formatTWD(r.final_price)}</span> },
    { key: 'transfer_last_5', label: '末 5 碼', className: 'text-center', render: (r) => <span className="font-mono">{r.transfer_last_5}</span> },
    {
      key: 'actions', label: '操作', className: 'text-right',
      render: (r) => canReconcile ? (
        <button className="rounded-md bg-brand-green px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-teal"
          onClick={() => setConfirming(r)}>對帳通過</button>
      ) : (
        <span className="text-xs text-gray-400" title="僅主管 / 管理員可對帳">唯讀</span>
      ),
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
              exportEnrollmentsCsv({ filenamePrefix: 'reconcile', enrollments: list, venueName });
              toast.success(`已匯出 ${list.length} 筆對帳資料 (CSV)`);
            }}
            onExportXlsx={() => {
              if (!list || list.length === 0) { toast.error('沒有可匯出的資料'); return; }
              exportEnrollmentsXlsx({ filenamePrefix: 'reconcile', enrollments: list, venueName });
              toast.success(`已匯出 ${list.length} 筆對帳資料 (XLSX)`);
            }}
          />
        }
      />
      <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="目前沒有待對帳的報名" />
      {confirming && (
        <InvoiceModal
          enrollment={confirming}
          canReconcile={canReconcile}
          onCancel={() => setConfirming(null)}
          onDone={() => { setConfirming(null); load(); }}
        />
      )}
    </div>
  );
}
