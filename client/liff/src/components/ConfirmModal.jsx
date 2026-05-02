import React, { useEffect } from 'react';

export default function ConfirmModal({
  open,
  title,
  children,
  confirmLabel = '確認',
  cancelLabel = '取消',
  onConfirm,
  onCancel,
  busy = false,
  tone = 'primary',
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onCancel]);

  if (!open) return null;

  const confirmStyle =
    tone === 'danger'
      ? 'bg-brand-error active:bg-brand-error-strong text-white'
      : 'bg-brand-teal active:bg-brand-primary text-white';

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={(e) => e.target === e.currentTarget && onCancel?.()}
    >
      <div className="w-full max-w-[390px] rounded-t-2xl bg-white p-5 sm:rounded-2xl">
        {title && <h3 className="mb-3 text-lg font-bold text-brand-primary">{title}</h3>}
        <div className="mb-5 text-sm text-gray-700">{children}</div>
        <div className="flex gap-3">
          <button
            type="button"
            className="flex-1 rounded-lg border border-gray-300 py-3 text-sm font-medium text-gray-700 active:bg-gray-100"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`flex-1 rounded-lg py-3 text-sm font-bold disabled:opacity-50 ${confirmStyle}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '處理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
