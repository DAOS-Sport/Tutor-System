import React, { useEffect, useRef } from 'react';

export default function ConfirmDialog({
  open, title, children,
  confirmLabel = '確認', cancelLabel = '取消',
  onConfirm, onCancel, busy = false, tone = 'primary', confirmDisabled = false,
}) {
  const cancelRef = useRef(null);

  // 預設 focus 在「取消」— 破壞性操作不該讓 Enter 鍵誤觸「確認」。
  // 只依賴 open：呼叫端的 onCancel 幾乎都是 inline 箭頭函式，每次 render 都是新身分。
  // 若把 onCancel 放進依賴陣列，對話框內的輸入框每打一個字就會重跑這個 effect、
  // 把焦點搶回「取消」按鈕（實際回報：輸入退回原因時打一個字就跳掉）。
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
  }, [open]);

  // Escape 關閉 + 鎖背景捲動：這段需要最新的 onCancel，維持原本的依賴。
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onCancel]);

  if (!open) return null;
  const confirmStyle = tone === 'danger'
    ? 'bg-brand-error hover:bg-brand-error-strong text-white'
    : 'bg-brand-teal hover:bg-brand-primary text-white';

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center md:px-4"
      onClick={(e) => e.target === e.currentTarget && onCancel?.()}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : '確認對話框'}
    >
      {/* children 由 14 個呼叫端塞任意內容（StaffPage 的硬刪確認就有整段 Ragic 說明、
          RefundPage 更長）。原本面板沒有高度上限：375×812 上內容一超過視窗就同時
          溢出上下兩緣，而 body 的捲動已被上面的 effect 鎖掉 —— 「確認 / 取消」被推到
          畫面外，整頁不能捲，只能重整。
          寫法對齊 ReconcilePage.jsx:372（全站唯一原本就寫對的）：外層 flex-col + 90dvh，
          中段自己捲，頭尾 shrink-0 釘住。dvh 不是 vh：iOS Safari 的 100vh 把收合中的
          網址列也算進去，用 vh 會比實際可見區高一截，按鈕照樣被壓在網址列底下。

          另一個原本在 375px 會發生的事：面板是置中的，即使高度夠、不溢出，「確認 / 取消」
          也停在螢幕垂直中線附近 —— 單手握手機時拇指自然覆蓋的是下三分之一，中線以上
          每次都要換手。而且置中卡片沒有「往下滑可以關掉」的暗示。
          改成 md 以下貼底升起的面板（items-end + rounded-t-2xl + 滿版 + 85dvh），
          md 以上原封不動回到 items-center + max-w-md + rounded-2xl + 90dvh。
          maxHeight 從 inline style 改寫成 class，是因為 inline style 沒有斷點可分。 */}
      <div className="flex max-h-[85dvh] w-full flex-col rounded-t-2xl bg-white shadow-xl pb-[env(safe-area-inset-bottom)] md:max-h-[90dvh] md:max-w-md md:rounded-2xl">
        {/* grabber：行動裝置上「這個可以往下拉」的通用暗示，桌機沒有這個手勢所以 md:hidden。 */}
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-gray-300 md:hidden" aria-hidden="true" />
        {title && <h3 className="shrink-0 px-6 pt-6 text-lg font-bold text-brand-primary">{title}</h3>}
        <div className={`flex-1 overflow-y-auto px-6 text-sm text-gray-700 ${title ? 'pt-3' : 'pt-6'}`}>{children}</div>
        <div className="flex shrink-0 justify-end gap-3 px-6 pb-6 pt-5">
          <button
            ref={cancelRef}
            type="button"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50 ${confirmStyle}`}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? '處理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
