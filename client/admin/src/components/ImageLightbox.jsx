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

/**
 * 放大級距。
 *
 * 原本在 375px 會發生什麼：燈箱只有一種尺寸 —— `max-h-[80vh] max-w-[92vw] object-contain`。
 * 匯款證明多半是 1000–3000px 寬的手機翻拍，被塞進 343px 的可視寬度後只剩原圖的
 * 四分之一多一點，「末 5 碼」那幾個數字實際高度不到 6px，肉眼讀不出來；而畫面上
 * 沒有任何放大控制，唯一能做的手勢（雙指縮放）又被 viewport meta 的 initial-scale=1
 * 擋在燈箱外面。更糟的是圖片四周的 letterbox 整片都是 backdrop，手指一碰就把燈箱關掉 ——
 * 櫃檯對帳要看清楚末 5 碼，只有這一條路，而這條路是走不通的。
 *
 * 用寬度百分比而不是 CSS transform：百分比會真的把元素撐大，外層 overflow 才會產生
 * 可捲動範圍，使用者能直接用手指拖曳平移；transform: scale() 不會改變版面尺寸，
 * 放大後超出的部分捲不到。
 */
const ZOOM_STEPS = ['', 'w-[250%]', 'w-[400%]'];
const ZOOM_LABELS = ['放大', '再放大', '還原'];

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
  const [zoom, setZoom] = useState(0);
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
    setZoom(0);
    setOpen(true);
  }

  function cycleZoom(event) {
    event?.preventDefault();
    event?.stopPropagation();
    setZoom((z) => (z + 1) % ZOOM_STEPS.length);
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
        {/* 放大控制釘在下緣正中央，不放右上角：單手拿 375 寬的手機時拇指只構得到下三分之一，
            而這顆鈕是「看清楚末 5 碼」的唯一入口，不能跟關閉鈕一起擠在最難按的角落。
            bottom 疊上安全區，避免落在 iPhone 的 home indicator 底下。 */}
        {!failed && (
          <button
            type="button"
            className="absolute bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-1/2 inline-flex h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-white/90 px-5 text-sm font-bold text-slate-900 shadow-lg transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-white"
            onClick={cycleZoom}
            aria-label={`${ZOOM_LABELS[zoom]}圖片`}
          >
            <MagnifierIcon className="h-4 w-4" />
            {ZOOM_LABELS[zoom]}
          </button>
        )}
        {/* 放大後這層變成捲動容器並吃掉整個覆蓋層：
            一來使用者可以直接拖曳平移到末 5 碼那一角，二來原本「圖片四周整片 letterbox
            都是 backdrop、手指一碰就關掉」的問題也一併消失 —— 放大狀態下只有右上角的
            ✕ 會關閉。未放大時維持原本的置中與 backdrop 點擊關閉，桌機看起來完全一樣。 */}
        <div
          className={zoom ? 'h-full w-full overflow-auto' : 'flex items-center justify-center'}
          onClick={(event) => { if (zoom) event.stopPropagation(); }}
        >
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
              className={`rounded-xl bg-white shadow-2xl transition duration-150 ${
                zoom
                  ? `block max-w-none ${ZOOM_STEPS[zoom]}`
                  : 'max-h-[80vh] max-w-[92vw] object-contain'
              } ${closing ? 'scale-95 opacity-0' : 'scale-100 opacity-100'} ${imageClassName}`}
              // 點圖片就進下一級放大：原本這裡只是 stopPropagation（碰到圖片不關閉、
              // 碰到旁邊就關閉），對「想看清楚一點」的人來說是完全沒有回饋的一次點擊。
              onClick={cycleZoom}
              onError={() => setFailed(true)}
            />
          )}
        </div>
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
