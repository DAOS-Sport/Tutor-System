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
  // pending_review / rejected 仍保留標籤以相容歷史資料，但新流程不再產生這些狀態
  pending_review: { label: '待審核', tone: 'amber' },
  active: { label: '啟用中', tone: 'green' },
  rejected: { label: '已退回', tone: 'errorSoft' },
  archived: { label: '已停用', tone: 'gray' },
};

// 改版後的篩選分頁：全部 / 草稿 / 啟用中 / 已停用
const FILTER_STATUSES = ['', 'draft', 'active', 'archived'];

function fmtDiscount(p) {
  return p.type === 'PERCENTAGE'
    ? `${Math.round(Number(p.discount_value) * 100)}%`
    : `折抵 NT$${Number(p.discount_value)}`;
}

export default function PromotionsPage() {
  const { role } = useAuth();
  const toast = useToast();
  const [allList, setAllList] = useState(null);
  const [filterStatus, setFilterStatus] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

  // 一次抓全部狀態，分頁切換前端過濾，讓每個分頁都能顯示正確筆數
  async function load() {
    setAllList(null);
    try {
      const data = await promotionsApi.list({});
      setAllList(Array.isArray(data) ? data : []);
    } catch {
      toast.error('載入優惠失敗');
      setAllList([]);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const counts = useMemo(() => {
    const c = { all: 0, draft: 0, active: 0, archived: 0 };
    if (Array.isArray(allList)) {
      c.all = allList.length;
      for (const p of allList) c[p.status] = (c[p.status] || 0) + 1;
    }
    return c;
  }, [allList]);

  // 優惠活動：manager 比照 admin（建立 / 上架 / 停用 / 刪除 / 複製皆可）
  const canManage = role === 'admin' || role === 'manager';

  const [actionBusy, setActionBusy] = useState(false);
  async function doAction(p, action, note) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      const fn = promotionsApi[action];
      await fn(p.id, note);
      toast.success(`已${{ activate: '上架', archive: '停用', remove: '刪除' }[action] || '更新'}`);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '操作失敗');
    } finally {
      setActionBusy(false);
      setConfirm(null);
    }
  }

  // 複製：以既有優惠欄位預填，但開成「新草稿」（清 id / 重設狀態 / 名稱加（複製）/ 清折價券代碼）
  function doCopy(p) {
    setEditing({
      name: `${p.name}（複製）`,
      description: p.description || '',
      type: p.type,
      discount_value: p.discount_value,
      min_threshold_type: p.min_threshold_type || '',
      min_threshold_value: p.min_threshold_value || '',
      applicable_course_types: Array.isArray(p.applicable_course_types) ? [...p.applicable_course_types] : [],
      applicable_venue_ids: Array.isArray(p.applicable_venue_ids) ? [...p.applicable_venue_ids] : [],
      coupon_code: '', // 折價券代碼為 UNIQUE，複製時必須清空
      start_date: p.start_date,
      end_date: p.end_date,
      max_uses: p.max_uses || '',
      platform_total_period_cap: p.platform_total_period_cap != null ? p.platform_total_period_cap : '',
      parent_period_cap: p.parent_period_cap != null ? p.parent_period_cap : '',
      // 不帶 id / status → 走新增（draft）路徑
    });
  }

  const filtered = useMemo(() => {
    if (!Array.isArray(allList)) return [];
    return filterStatus ? allList.filter((p) => p.status === filterStatus) : allList;
  }, [allList, filterStatus]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="優惠活動 (F-M07 / F-A05)"
        actions={canManage && (
          <button onClick={() => setEditing({})} className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary">
            + 新增優惠
          </button>
        )}
      />

      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-3 shadow-sm">
        <span className="text-xs font-medium text-gray-500">狀態：</span>
        {FILTER_STATUSES.map((s) => (
          <button key={s || 'all'} onClick={() => setFilterStatus(s)}
            className={`rounded-full px-3 py-1 text-xs ${filterStatus === s ? 'bg-brand-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {s ? STATUS_LABELS[s]?.label : '全部'}（{Array.isArray(allList) ? (s === '' ? counts.all : counts[s] || 0) : '…'}）
          </button>
        ))}
      </div>

      {allList === null ? (
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
                <th className="px-3 py-2 text-left">已用 / 上限</th>
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
                    <td className="px-3 py-2 text-xs text-gray-500">
                      <div>{p.current_uses}{p.max_uses ? ` / ${p.max_uses}` : ''} 次</div>
                      {(p.platform_total_period_cap != null || p.parent_period_cap != null) && (
                        <div className="mt-0.5 text-[11px] text-gray-400">
                          期數 {p.current_period_uses || 0}{p.platform_total_period_cap != null ? ` / ${p.platform_total_period_cap}` : ' / 不限'}
                          {p.parent_period_cap != null ? `，每家長 ${p.parent_period_cap}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2"><StatusBadge tone={stMeta.tone}>{stMeta.label}</StatusBadge></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button onClick={() => setEditing(p)} className="rounded bg-gray-100 px-2 py-1 text-xs hover:bg-gray-200">檢視</button>
                        {canManage && ['draft', 'rejected'].includes(p.status) && (
                          <button onClick={() => setConfirm({ p, action: 'activate', label: '上架' })}
                            className="rounded bg-brand-green px-2 py-1 text-xs text-white hover:opacity-90">上架</button>
                        )}
                        {canManage && p.status !== 'archived' && (
                          <button onClick={() => setConfirm({ p, action: 'archive', label: '停用' })}
                            className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-300">停用</button>
                        )}
                        {canManage && (
                          <button onClick={() => doCopy(p)}
                            className="rounded bg-brand-teal px-2 py-1 text-xs text-white hover:opacity-90">複製</button>
                        )}
                        {canManage && (
                          <button onClick={() => setConfirm({ p, action: 'remove', label: '刪除' })}
                            className="rounded bg-brand-error px-2 py-1 text-xs text-white hover:opacity-90">刪除</button>
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

      {editing && (() => {
        // 改版：只有 draft 可編輯；active 已上架 / archived 已停用皆為唯讀（active 請刪除後重建）
        const editableStatuses = ['draft', 'rejected'];
        const ro = !!editing.id && !editableStatuses.includes(editing.status);
        return (
          <PromotionFormModal
            initial={editing}
            readOnly={ro}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); }}
          />
        );
      })()}

      <ConfirmWithNote
        open={!!confirm}
        title={confirm ? `確定要「${confirm.label}」優惠：${confirm.p.name}？` : ''}
        confirmLabel={confirm?.label}
        requireNote={!!confirm?.requireNote}
        busy={actionBusy}
        onCancel={() => !actionBusy && setConfirm(null)}
        onConfirm={(note) => doAction(confirm.p, confirm.action, note)}
      />
    </div>
  );
}
