import React, { useState } from 'react';
import { slotsApi } from '../../api/slots';
import { formatTWDateTime } from '../../utils/format';

/**
 * 點擊槽位後跳出底部 action sheet：
 *  - available: [封鎖] [刪除]
 *  - blocked:   [解封]
 *  - booked:    [檢視] (只顯示資訊)
 */
export default function SlotActionSheet({ slot, onClose, onMutated, onError }) {
  const [busy, setBusy] = useState(false);

  async function run(fn) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onMutated && onMutated();
      onClose();
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || '操作失敗';
      onError ? onError(msg) : alert(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <div className="w-full max-w-[390px] mx-auto rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3">
          <div className="text-xs text-gray-500">{slot.venue_name || slot.venue_id}</div>
          <div className="text-base font-bold text-brand-primary">
            {formatTWDateTime(slot.start_at)} · {slot.duration_minutes} 分
          </div>
          {slot.status === 'booked' && (
            <div className="mt-1 text-xs text-gray-700">
              學員：{(slot.student_names || []).join('、') || '—'}
            </div>
          )}
          {slot.notes && <div className="mt-1 text-[11px] text-gray-400">備註：{slot.notes}</div>}
        </div>

        <div className="space-y-2">
          {slot.status === 'available' && (
            <>
              <ActionButton onClick={() => run(() => slotsApi.block(slot.id))} disabled={busy}>
                封鎖此時段（不開放預約）
              </ActionButton>
              <ActionButton onClick={() => run(() => slotsApi.remove(slot.id))} disabled={busy} danger>
                刪除此槽位
              </ActionButton>
            </>
          )}
          {slot.status === 'blocked' && (
            <ActionButton onClick={() => run(() => slotsApi.unblock(slot.id))} disabled={busy}>
              解除封鎖（恢復可預約）
            </ActionButton>
          )}
          {slot.status === 'booked' && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
              已預約的時段須由家長端取消後才能釋回。
            </div>
          )}
          {slot.status === 'pending_group_confirm' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              此槽位等待小組確認中，自動確認時間到後將決定狀態。
            </div>
          )}
        </div>

        <button type="button" onClick={onClose}
          className="mt-3 w-full rounded-lg border border-gray-300 py-2 text-sm text-gray-600">
          取消
        </button>
      </div>
    </div>
  );
}

function ActionButton({ onClick, disabled, danger, children }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`w-full rounded-lg py-3 text-sm font-bold disabled:opacity-50 ${
        danger
          ? 'border border-brand-error/40 text-brand-error active:bg-brand-error-soft'
          : 'bg-brand-primary text-white active:bg-brand-teal'
      }`}>
      {children}
    </button>
  );
}
