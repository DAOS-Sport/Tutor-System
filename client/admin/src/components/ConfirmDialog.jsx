import React, { useEffect, useRef } from 'react';

export default function ConfirmDialog({
  open, title, children,
  confirmLabel = '確認', cancelLabel = '取消',
  onConfirm, onCancel, busy = false, tone = 'primary', confirmDisabled = false,
}) {
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    // 預設 focus 在「取消」— 破壞性操作不該讓 Enter 鍵誤觸「確認」。
    cancelRef.current?.focus();
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
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && onCancel?.()}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : '確認對話框'}
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        {title && <h3 className="mb-3 text-lg font-bold text-brand-primary">{title}</h3>}
        <div className="mb-5 text-sm text-gray-700">{children}</div>
        <div className="flex justify-end gap-3">
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
