import React, { useEffect } from 'react';

export const PAYMENT_DISCLAIMER_MESSAGE = '我已經和教練溝通確認可以上課跟說好購買堂數';

export default function PaymentDisclaimerModal({
  open,
  onAgree,
  onCancel,
  busy = false,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event) {
      if (event.key === 'Escape' && !busy) {
        onCancel?.();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, onCancel, open]);

  if (!open) return null;

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget && !busy) {
      onCancel?.();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 px-4 pb-5 sm:items-center sm:pb-0"
      onClick={handleBackdropClick}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-describedby="payment-disclaimer-message"
        className="w-full max-w-[390px] rounded-2xl bg-white p-5 shadow-xl"
      >
        <p
          id="payment-disclaimer-message"
          className="text-center text-base font-bold leading-7 text-brand-primary"
        >
          {PAYMENT_DISCLAIMER_MESSAGE}
        </p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-xl border border-gray-300 bg-white py-3.5 text-base font-bold text-gray-600 active:bg-gray-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onAgree}
            className="rounded-xl bg-brand-primary py-3.5 text-base font-bold text-white shadow-sm active:bg-brand-teal disabled:bg-gray-300"
          >
            我同意
          </button>
        </div>
      </div>
    </div>
  );
}
