import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { enrollmentsApi } from '../api/enrollments';
import { venuesApi } from '../api/venues';
import {
  formatTWD, formatTWDateTime, courseTypeLabel,
  paymentStatusLabel, paymentStatusTone,
} from '../utils/format';
import { exportEnrollmentsCsv, exportEnrollmentsXlsx } from '../utils/csvExport';
import { useToast } from '../context/ToastContext';
import ExportMenu from '../components/ExportMenu';
import EditEnrollmentModal from './enrollments/EditEnrollmentModal';
import ImageLightbox from '../components/ImageLightbox';

const STATUS_OPTIONS = [
  { value: '',                 label: '全部狀態' },
  { value: 'pending_payment',  label: '待對帳' },
  { value: 'confirmed',        label: '已對帳' },
  { value: 'active',           label: '進行中' },
  { value: 'cancelled',        label: '已取消' },
  { value: 'refunded',         label: '已退費' },
];

const EDITABLE_STATUSES = ['pending_payment', 'confirmed', 'active'];

export default function EnrollmentsPage() {
  const { user, isStaff, isAdmin, isManager } = useAuth();
  const toast = useToast();
  const [filters, setFilters] = useState({ status: '', search: '' });
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);

  const canEdit = isAdmin || isManager || isStaff;

  useEffect(() => { venuesApi.list().then(setVenues); }, []);

  useEffect(() => {
    let alive = true;
    setList(null);
    const venueId = isStaff ? user?.venue_id : undefined;
    enrollmentsApi.list({ ...filters, venueId }).then((d) => { if (alive) setList(d); });
    return () => { alive = false; };
  }, [filters, isStaff, user]);

  const venueMap = useMemo(() => Object.fromEntries(venues.map((v) => [v.id, v.name])), [venues]);

  const columns = [
    { key: 'id', label: '編號', render: (r) => <button className="font-mono text-xs text-brand-teal hover:underline" onClick={() => setDetail(r)}>{r.id}</button> },
    { key: 'submitted_at', label: '送出', render: (r) => <span className="text-xs text-gray-600">{formatTWDateTime(r.submitted_at)}</span> },
    { key: 'parent', label: '家長', render: (r) => <div className="text-sm"><div className="font-medium">{r.parent_name}</div><div className="text-xs text-gray-500">{r.parent_phone}</div></div> },
    { key: 'students', label: '學員', render: (r) => r.students.join('、') },
    { key: 'coach', label: '教練 / 場館', render: (r) => <div><div>{r.coach}</div><div className="text-xs text-gray-500">{venueMap[r.venue_id] || r.venue_id}</div></div> },
    { key: 'course_type', label: '組別', render: (r) => <StatusBadge tone="teal">{courseTypeLabel(r.course_type)}</StatusBadge> },
    { key: 'final_price', label: '金額', className: 'text-right', render: (r) => <span className="font-mono">{formatTWD(r.final_price)}</span> },
    { key: 'status', label: '狀態', render: (r) => <StatusBadge tone={paymentStatusTone(r.status)}>{paymentStatusLabel(r.status)}</StatusBadge> },
  ];

  function handleSaved(updated) {
    setEditing(null);
    setDetail(updated);
    setList((prev) => prev ? prev.map((e) => (e.id === updated.id ? updated : e)) : prev);
  }

  return (
    <div>
      <PageHeader
        title="所有報名"
        subtitle={`F-R02 · 共 ${list?.length ?? '—'} 筆${isStaff ? '（限本場館）' : ''}`}
        actions={
          <ExportMenu
            disabled={!list || list.length === 0}
            onExportCsv={() => {
              if (!list || list.length === 0) { toast.error('沒有可匯出的資料'); return; }
              exportEnrollmentsCsv({ filenamePrefix: 'enrollments', enrollments: list, venueName: (id) => venueMap[id] || id });
              toast.success(`已匯出 ${list.length} 筆報名資料 (CSV)`);
            }}
            onExportXlsx={() => {
              if (!list || list.length === 0) { toast.error('沒有可匯出的資料'); return; }
              exportEnrollmentsXlsx({ filenamePrefix: 'enrollments', enrollments: list, venueName: (id) => venueMap[id] || id });
              toast.success(`已匯出 ${list.length} 筆報名資料 (XLSX)`);
            }}
          />
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <select
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input
          type="text"
          placeholder="搜尋家長 / 手機 / 教練 / 學員 / 編號"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          className="flex-1 min-w-[240px] rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      {!list ? <LoadingSpinner /> : <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="沒有符合條件的資料" />}

      {detail && !editing && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => e.target === e.currentTarget && setDetail(null)}
          role="dialog"
          aria-modal="true"
          aria-label="報名明細"
        >
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-brand-primary">報名明細 {detail.id}</h3>
              <StatusBadge tone={paymentStatusTone(detail.status)}>{paymentStatusLabel(detail.status)}</StatusBadge>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-gray-500">家長</dt><dd>{detail.parent_name} ({detail.parent_phone})</dd></div>
              <div><dt className="text-gray-500">學員</dt><dd>{detail.students.join('、')}</dd></div>
              <div><dt className="text-gray-500">教練</dt><dd>{detail.coach}</dd></div>
              <div><dt className="text-gray-500">場館</dt><dd>{venueMap[detail.venue_id] || detail.venue_id}</dd></div>
              <div><dt className="text-gray-500">組別</dt><dd>{courseTypeLabel(detail.course_type)}</dd></div>
              <div><dt className="text-gray-500">轉帳末 5</dt><dd className="font-mono">{detail.transfer_last_5}</dd></div>
              <div><dt className="text-gray-500">原價 / 應收</dt><dd>{formatTWD(detail.original_price)} → <b>{formatTWD(detail.final_price)}</b></dd></div>
              {detail.total_sessions != null && (
                <div><dt className="text-gray-500">堂數</dt><dd>{detail.used_sessions || 0} / {detail.total_sessions}</dd></div>
              )}
            </dl>

            {detail.extra_parent_phones && detail.extra_parent_phones.length > 0 && (
              <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-3">
                <div className="mb-1 text-xs font-bold text-blue-700">📱 附加家長手機（多組家庭）</div>
                <div className="flex flex-wrap gap-2">
                  {detail.extra_parent_phones.map((p) => (
                    <span key={p} className="rounded-full bg-blue-100 px-2 py-0.5 font-mono text-xs text-blue-800">{p}</span>
                  ))}
                </div>
              </div>
            )}

            {detail.notes && (
              <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
                <span className="font-bold text-gray-500">備注：</span>{detail.notes}
              </div>
            )}

            {detail.payment_proof_url && (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 text-sm font-bold text-slate-700">匯款／轉帳證明</div>
                <ImageLightbox
                  src={detail.payment_proof_url}
                  alt="匯款證明"
                  label="匯款／轉帳證明"
                />
              </div>
            )}

            {detail.invoice_number && (
              <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50 p-4">
                <div className="mb-3 text-sm font-bold text-teal-700">🧾 發票資訊</div>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-gray-500">發票號碼</dt>
                    <dd className="font-mono font-bold text-teal-800">{detail.invoice_number}</dd>
                  </div>
                  {detail.invoice_issued_at && (
                    <div>
                      <dt className="text-gray-500">開立時間</dt>
                      <dd>{formatTWDateTime(detail.invoice_issued_at)}</dd>
                    </div>
                  )}
                  {detail.invoice_url && (
                    <div className="col-span-2">
                      <dt className="text-gray-500">電子發票查詢</dt>
                      <dd><a href={detail.invoice_url} target="_blank" rel="noreferrer" className="text-brand-teal underline hover:opacity-75">{detail.invoice_url}</a></dd>
                    </div>
                  )}
                  {detail.invoice_image_url && (
                    <div className="col-span-2">
                      <dt className="mb-1 text-gray-500">發票照片</dt>
                      <dd>
                        <ImageLightbox
                          src={detail.invoice_image_url}
                          alt="發票"
                          label="發票照片"
                        />
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            <div className="mt-5">
              <div className="mb-2 text-sm font-bold text-gray-700">操作紀錄</div>
              <ul className="space-y-1 text-xs text-gray-600">
                {detail.audit_logs.map((a, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-36 shrink-0 font-mono text-gray-400">{a.at.replace('T', ' ')}</span>
                    <span className="flex-1">{a.action}</span>
                    <span className="text-gray-500">— {a.by}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-5 flex justify-between items-center">
              {canEdit && EDITABLE_STATUSES.includes(detail.status) ? (
                <button
                  onClick={() => setEditing(detail)}
                  className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white hover:bg-brand-teal"
                >
                  ✏️ 編輯資料
                </button>
              ) : (
                <span />
              )}
              <button
                onClick={() => setDetail(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                關閉
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <EditEnrollmentModal
          enrollment={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
