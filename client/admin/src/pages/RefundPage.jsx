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
  paymentStatusLabel, paymentStatusTone,
} from '../utils/format';

export default function RefundPage() {
  const toast = useToast();
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [target, setTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const previewReqRef = useRef(0);

  async function load() {
    const [data, vs] = await Promise.all([
      enrollmentsApi.list(),
      venuesApi.list(),
    ]);
    setList(data.filter((e) => e.status === 'active' || e.status === 'confirmed' || e.status === 'cancelled'));
    setVenues(vs);
  }
  useEffect(() => { load(); }, []);

  async function openRefund(row) {
    setTarget(row);
    setReason('');
    setPreview(null);
    const reqId = ++previewReqRef.current;
    const p = await enrollmentsApi.refundPreview(row.id);
    // 若使用者在 fetch 中又開了另一列、或關閉 modal，丟掉這次回應
    if (reqId !== previewReqRef.current) return;
    setPreview(p);
  }

  function closeRefund() {
    previewReqRef.current += 1; // 讓尚未回來的 preview 失效
    setTarget(null);
    setPreview(null);
  }

  async function doRefund() {
    if (!reason.trim()) {
      toast.warning('請填寫退課理由');
      return;
    }
    setBusy(true);
    try {
      const res = await enrollmentsApi.refund(target.id, reason.trim(), user.name);
      toast.success(`已完成退課，退款 ${formatTWD(res.refund_amount)}`);
      closeRefund();
      await load();
    } catch {
      toast.error('退課失敗');
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
  ];

  return (
    <div>
      <PageHeader title="退課處理" subtitle="F-R04 · 主管權限。退款 = 剩餘比例 × (1 − 手續費率)" />
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
            <ul className="space-y-1 rounded-lg border border-gray-200 p-3">
              <li className="flex justify-between"><span className="text-gray-600">原應收</span><span className="font-mono">{formatTWD(preview.enrollment.final_price)}</span></li>
              <li className="flex justify-between"><span className="text-gray-600">已使用堂數</span><span>{preview.used} / {preview.total}</span></li>
              <li className="flex justify-between"><span className="text-gray-600">剩餘比例</span><span>{(preview.remainRatio * 100).toFixed(1)}%</span></li>
              <li className="flex justify-between"><span className="text-gray-600">手續費率</span><span>{(preview.fee_rate * 100).toFixed(0)}%</span></li>
              <li className="flex justify-between border-t border-gray-200 pt-2 font-bold text-brand-error-strong"><span>應退款金額</span><span className="font-mono">{formatTWD(preview.refund_amount)}</span></li>
            </ul>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">退課理由（必填，會記入 audit log）</label>
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2"
                placeholder="例：家長因搬家無法繼續上課"
              />
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
