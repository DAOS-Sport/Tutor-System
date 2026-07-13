import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createLocalPreview, resolveImagePreviewSource } from '../utils/imagePreview.mjs';

function MagnifierIcon({ className = '' }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.25" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12.5 12.5L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon({ className = '' }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M5 5L15 15M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ImagePreviewCard({
  src,
  alt = '圖片預覽',
  label,
  className = '',
  thumbnailClassName = '',
  imageClassName = '',
  fileName = '',
  onRetry,
}) {
  const resolved = resolveImagePreviewSource(src);
  const [localUrl, setLocalUrl] = useState('');
  const imageSrc = resolved.kind === 'local' ? localUrl : resolved.url;
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [failed, setFailed] = useState(false);
  const closeTimerRef = useRef(null);

  useEffect(() => {
    if (resolved.kind !== 'local' || !resolved.blob) {
      setLocalUrl('');
      return undefined;
    }
    const local = createLocalPreview(resolved.blob);
    setLocalUrl(local.url);
    return () => local.revoke();
  }, [src]);

  useEffect(() => {
    setFailed(false);
  }, [imageSrc]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
    // requestClose is intentionally stable for this component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closing]);

  if (!imageSrc && !failed) return null;

  function openModal(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    setClosing(false);
    setOpen(true);
  }

  function requestClose(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 160);
  }

  const ariaLabel = label ? `放大檢視：${label}` : '放大檢視圖片';

  const modal = open && typeof document !== 'undefined'
    ? createPortal(
      <div
        className={`fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm transition-opacity duration-150 ${closing ? 'opacity-0' : 'opacity-100'}`}
        onClick={requestClose}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <button
          type="button"
          className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-900 shadow-lg transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-white"
          onClick={requestClose}
          aria-label="關閉圖片預覽"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
        {failed ? (
          <div
            className={`rounded-xl bg-white px-6 py-5 text-sm font-medium text-slate-600 shadow-2xl transition duration-150 ${closing ? 'scale-95 opacity-0' : 'scale-100 opacity-100'}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div>圖片載入失敗，可重新上傳</div>
            {(fileName || resolved.name) && <div className="mt-1 text-xs text-slate-400">{fileName || resolved.name}</div>}
            {onRetry && (
              <button type="button" className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold" onClick={onRetry}>
                重新上傳
              </button>
            )}
          </div>
        ) : (
          <img
            src={imageSrc}
            alt={alt}
            className={`max-h-[80vh] max-w-[92vw] rounded-xl bg-white object-contain shadow-2xl transition duration-150 ${closing ? 'scale-95 opacity-0' : 'scale-100 opacity-100'} ${imageClassName}`}
            onClick={(event) => event.stopPropagation()}
            onError={() => setFailed(true)}
          />
        )}
      </div>,
      document.body
    )
    : null;

  return (
    <>
      <button
        type="button"
        className={`group relative inline-flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white/70 shadow-sm backdrop-blur transition-all hover:scale-105 hover:border-slate-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-teal ${thumbnailClassName} ${className}`}
        title={ariaLabel}
        aria-label={ariaLabel}
        onClick={openModal}
      >
        {failed ? (
          <span className="px-2 text-center text-[11px] font-medium leading-tight text-slate-500">圖片載入失敗，可重新上傳</span>
        ) : (
          <img
            src={imageSrc}
            alt={alt}
            className="h-full w-full object-contain"
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
        <span className="absolute inset-0 bg-black/0 transition group-hover:bg-black/10" aria-hidden="true" />
        <span className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-sm opacity-90 backdrop-blur transition group-hover:opacity-100">
          <MagnifierIcon className="h-3.5 w-3.5" />
        </span>
      </button>
      {modal}
    </>
  );
}

export const ImageLightbox = ImagePreviewCard;
export default ImagePreviewCard;
