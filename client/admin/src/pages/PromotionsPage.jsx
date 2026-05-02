import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { promotionsApi } from '../api/promotions';
import PromotionFormModal from './promotions/PromotionFormModal';

function ConfirmWithNote({ open, title, requireNote, busy, onCancel, onConfirm, confirmLabel }) {
  const [note, setNote] = React.useState('');
  React.useEffect(() => { if (!open) setNote(''); }, [open]);
  return (
    <ConfirmDialog
      open={open}
      title={title}
      busy={busy}
      confirmLabel={confirmLabel}
      onCancel={onCancel}
      confirmDisabled={requireNote && !note.trim()}
      onConfirm={() => {
        const trimmed = note.trim();
        if (requireNote && !trimmed) return;
        onConfirm(trimmed || null);
      }}
    >
      {requireNote && (
        <textarea value={note} onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-lg border border-gray-300 p-2 text-sm" rows={3}
          placeholder="退回原因（必填）" />
      )}
    </ConfirmDialog>
  );
}

const STATUS_LABELS = {
  draft: { label: '草稿', tone: 'gray' },
  pending_review: { label: '待審核', tone: 'amber' },
  active: { label: '啟用中', tone: 'green' },
  rejected: { label: '已退回', tone: 'errorSoft' },
  archived: { label: '已停用', tone: 'gray' },
};

function fmtDiscount(p) {
  return p.type === 'PERCENTAGE'
    ? `${Math.round(Number(p.discount_value) * 100)}%`
    : `折抵 NT$${Number(p.discount_value)}`;
}

export default function PromotionsPage() {
  const { role } = useAuth();
  const toast = useToast();
  const [list, setList] = useState(null);
  const [filterStatus, setFilterStatus] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

  async function load() {
    setList(null);
    try {
      const data = await promotionsApi.list(filterStatus ? { status: filterStatus } : {});
      setList(data);
    } catch {
      toast.error('載入優惠失敗');
      setList([]);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filterStatus]);

  const canCreate  = role === 'admin' || role === 'manager';
  const canApprove = role === 'admin';

  async function doAction(p, action, note) {
    try {
      const fn = promotionsApi[action];
      await fn(p.id, note);
      toast.success(`已${{ submit: '送審', approve: '核准', reject: '退回', archive: '停用' }[action] || '更新'}`);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '操作失敗');
    } finally {
      setConfirm(null);
    }
  }

  const filtered = useMemo(() => list || [], [list]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="優惠活動 (F-M07 / F-A05)"
        actions={canCreate && (
          <button onClick={() => setEditing({})} className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary">
            + 新增優惠
          </button>
        )}
      />

      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-3 shadow-sm">
        <span className="text-xs font-medium text-gray-500">狀態：</span>
        {['', 'draft', 'pending_review', 'active', 'rejected', 'archived'].map((s) => (
          <button key={s || 'all'} onClick={() => setFilterStatus(s)}
            className={`rounded-full px-3 py-1 text-xs ${filterStatus === s ? 'bg-brand-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {s ? STATUS_LABELS[s]?.label : '全部'}
          </button>
        ))}
      </div>

      {list === null ? (
        <LoadingSpinner />
      ) : filtered.length === 0 ? (
        <div className="rounded-lg bg-white p-10 text-center text-sm text-gray-400">目前沒有優惠活動。</div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">名稱 / 折價券</th>
                <th className="px-3 py-2 text-left">折扣</th>
                <th className="px-3 py-2 text-left">期間</th>
                <th className="px-3 py-2 text-left">使用 / 上限</th>
                <th className="px-3 py-2 text-left">狀態</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((p) => {
                const stMeta = STATUS_LABELS[p.status] || STATUS_LABELS.draft;
                return (
                  <tr key={p.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-800">{p.name}</div>
                      {p.coupon_code && <div className="text-[11px] font-mono text-brand-teal">{p.coupon_code}</div>}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{fmtDiscount(p)}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{p.start_date} ～ {p.end_date}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{p.current_uses}{p.max_uses ? ` / ${p.max_uses}` : ''}</td>
                    <td className="px-3 py-2"><StatusBadge tone={stMeta.tone}>{stMeta.label}</StatusBadge></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button onClick={() => setEditing(p)} className="rounded bg-gray-100 px-2 py-1 text-xs hover:bg-gray-200">檢視</button>
                        {canCreate && ['draft', 'rejected'].includes(p.status) && (
                          <button onClick={() => setConfirm({ p, action: 'submit', label: '送審' })}
                            className="rounded bg-brand-amber px-2 py-1 text-xs text-white hover:opacity-90">送審</button>
                        )}
                        {canApprove && p.status === 'pending_review' && (
                          <>
                            <button onClick={() => setConfirm({ p, action: 'approve', label: '核准啟用' })}
                              className="rounded bg-brand-green px-2 py-1 text-xs text-white hover:opacity-90">核准</button>
                            <button onClick={() => setConfirm({ p, action: 'reject', label: '退回', requireNote: true })}
                              className="rounded bg-brand-error px-2 py-1 text-xs text-white hover:opacity-90">退回</button>
                          </>
                        )}
                        {canCreate && p.status !== 'archived' && (
                          <button onClick={() => setConfirm({ p, action: 'archive', label: '停用' })}
                            className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-300">停用</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <PromotionFormModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      <ConfirmWithNote
        open={!!confirm}
        title={confirm ? `確定要「${confirm.label}」優惠：${confirm.p.name}？` : ''}
        confirmLabel={confirm?.label}
        requireNote={!!confirm?.requireNote}
        onCancel={() => setConfirm(null)}
        onConfirm={(note) => doAction(confirm.p, confirm.action, note)}
      />
    </div>
  );
}
