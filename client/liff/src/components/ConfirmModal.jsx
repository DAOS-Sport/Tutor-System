import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

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

  // 掛到 document.body（而非留在 AppLayout 的手機殼 DOM 裡）：AppLayout 外層容器是
  // h-dvh + overflow-hidden，iOS Safari / LINE LIFF 內建 WKWebView 對「position:fixed
  // 巢狀在 overflow 祖先內」有已知 bug，會把 fixed 誤判成相對該祖先定位/裁切，導致這個
  // 彈窗的下緣（送出按鈕）被同層的 BottomNav 蓋住、點不到。Portal 出去可從根本避開。
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      onClick={(e) => e.target === e.currentTarget && onCancel?.()}
    >
      <div className="flex max-h-[85dvh] w-full max-w-[390px] flex-col overflow-hidden rounded-t-2xl bg-white sm:rounded-2xl">
        <div className="flex-1 overflow-y-auto p-5">
          {title && <h3 className="mb-3 text-lg font-bold text-brand-primary">{title}</h3>}
          <div className="text-sm text-gray-700">{children}</div>
        </div>
        <div
          className="flex shrink-0 gap-3 border-t border-gray-100 px-5 pt-4"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 24px)' }}
        >
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
    </div>,
    document.body
  );
}
