import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { groupOrdersApi } from '../api/groupOrders';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';

const STATUS_META = {
  forming: { label: '揪團中', cls: 'bg-brand-teal/15 text-brand-teal' },
  submitted: { label: '審核中', cls: 'bg-brand-gold/15 text-brand-gold' },
  approved: { label: '已成團', cls: 'bg-brand-green/15 text-brand-green' },
  rejected: { label: '已退回', cls: 'bg-brand-error/10 text-brand-error' },
  cancelled: { label: '已取消', cls: 'bg-gray-100 text-gray-500' },
};

export default function GroupStatusPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [order, setOrder] = useState(undefined); // undefined=loading, null=error
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'submit' | 'cancel' | null

  const load = useCallback(() => {
    let alive = true;
    groupOrdersApi.get(id)
      .then((d) => alive && setOrder(d || null))
      .catch(() => alive && setOrder(null));
    return () => { alive = false; };
  }, [id]);

  useEffect(() => load(), [load]);

  if (order === undefined) return <LoadingSpinner fullPage label="載入團購狀態…" />;
  if (order === null) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="mb-3 text-sm text-brand-error">找不到此團購</div>
        <button type="button" onClick={() => navigate('/', { replace: true })}
          className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white">回首頁</button>
      </div>
    );
  }

  const meta = STATUS_META[order.status] || { label: order.status, cls: 'bg-gray-100 text-gray-500' };
  const reachedMin = order.total_students >= order.min_students;
  const joinUrl = order.is_leader ? `${window.location.origin}/liff/group/join/${order.join_token || ''}` : null;

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast.success('邀請連結已複製，貼到群組分享吧！');
    } catch {
      toast.error('複製失敗，請手動複製');
    }
  }

  async function doAction(kind) {
    setBusy(true);
    try {
      if (kind === 'submit') {
        await groupOrdersApi.submit(id);
        toast.success('已送審，等待櫃檯核准');
      } else {
        await groupOrdersApi.cancel(id);
        toast.success('團購已取消');
      }
      setConfirm(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '操作失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-brand-primary">{courseTypeLabel(order.course_type)} 團購</h2>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.cls}`}>{meta.label}</span>
        </div>
        <p className="mt-2 text-sm text-gray-700">
          目前 <span className="font-bold text-brand-primary">{order.total_students}</span> 人
          <span className="text-gray-400">（開團需 {order.min_students}–{order.max_students} 人）</span>
        </p>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div className={`h-full rounded-full transition-all ${reachedMin ? 'bg-brand-green' : 'bg-brand-gold'}`}
            style={{ width: `${Math.min(100, Math.round((order.total_students / order.max_students) * 100))}%` }} />
        </div>
        {order.note && <p className="mt-2 text-xs text-gray-500">備註：{order.note}</p>}
        {order.status === 'rejected' && order.reject_reason && (
          <p className="mt-2 rounded-lg bg-brand-error/5 px-2 py-1 text-xs text-brand-error">退回原因：{order.reject_reason}</p>
        )}
      </div>

      {order.is_leader && order.status === 'forming' && joinUrl && (
        <div className="mb-4 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-3">
          <label className="mb-1 block text-xs font-medium text-gray-600">邀請其他家長加入</label>
          <div className="flex gap-2">
            <input readOnly value={joinUrl}
              className="flex-1 truncate rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-600" />
            <button type="button" onClick={copyInvite}
              className="shrink-0 rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white">複製</button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <h3 className="mb-2 text-xs font-bold text-gray-600">成員（{order.member_count} 個家庭）</h3>
        <div className="space-y-2">
          {(order.members || []).map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-gray-800">{m.parent_name}</span>
                  {m.is_leader && <span className="rounded bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-brand-primary">團主</span>}
                  {m.is_self && <span className="rounded bg-brand-teal/10 px-1.5 py-0.5 text-[10px] font-bold text-brand-teal">您</span>}
                </div>
                <p className="mt-0.5 truncate text-xs text-gray-500">學生：{(m.student_names || []).join('、') || '—'}</p>
              </div>
              <span className="shrink-0 text-xs text-gray-400">
                {m.has_payment_proof ? '已附證明' : '缺證明'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {order.is_leader && order.status === 'forming' && (
        <div className="mt-4 space-y-2">
          <button
            type="button"
            disabled={!reachedMin || busy}
            onClick={() => setConfirm('submit')}
            className="w-full rounded-lg bg-brand-primary py-3.5 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300"
          >
            {reachedMin ? '送審（湊滿開團人數）' : `還差 ${order.min_students - order.total_students} 人才能送審`}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirm('cancel')}
            className="w-full rounded-lg border border-brand-error/40 py-2.5 text-sm font-bold text-brand-error">取消團購</button>
        </div>
      )}

      <ConfirmModal
        open={confirm === 'submit'}
        title="確認送審？"
        confirmLabel="確認送審"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => doAction('submit')}
      >
        <p className="text-sm text-gray-600">送審後將無法再加入新成員，由櫃檯核准後正式成團並建立報名。</p>
      </ConfirmModal>

      <ConfirmModal
        open={confirm === 'cancel'}
        title="確認取消團購？"
        confirmLabel="確認取消"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => doAction('cancel')}
      >
        <p className="text-sm text-gray-600">取消後此團購將關閉，已加入的成員都會失效，此動作無法復原。</p>
      </ConfirmModal>
    </div>
  );
}
