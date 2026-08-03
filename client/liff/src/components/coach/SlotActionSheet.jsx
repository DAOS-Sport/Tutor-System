// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔凍結範圍：不得加回 pending_group_confirm 等待確認提示。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
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
  // 嚴格布林：後端沒回這個欄位時（舊版本、mock）一律當手建處理，不可用 !== false，
  // 否則 undefined 會被當成自動時段，把手建槽位的「刪除」也一起藏掉。
  const isAuto = slot.is_auto === true;

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
          {/* auto 時段 venue_id 為 NULL（跨場館），沒有場館名可顯示 */}
          <div className="text-xs text-gray-500">{slot.venue_name || slot.venue_id || '全場館共用'}</div>
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
                {isAuto ? '關閉此時段（不開放預約）' : '封鎖此時段（不開放預約）'}
              </ActionButton>
              {/* 自動時段不提供「刪除」：刪掉只是抹掉這一列，下個產生週期會照場館營業
                  時間原樣長回來，教練會以為關掉了其實沒關。關班的唯一持久做法是封鎖
                  ——產生器會回看前一週期的 blocked 並沿用。手建的槽位沒有這個問題。 */}
              {!isAuto && (
                <ActionButton onClick={() => run(() => slotsApi.remove(slot.id))} disabled={busy} danger>
                  刪除此槽位
                </ActionButton>
              )}
              {isAuto && (
                <p className="px-1 text-[11px] leading-relaxed text-gray-500">
                  這是依場館營業時間自動開放的時段。關閉後會沿用到之後的週期，要恢復隨時可解除。
                </p>
              )}
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
