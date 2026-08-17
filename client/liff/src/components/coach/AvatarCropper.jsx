import React, { useEffect, useRef, useState } from 'react';

/**
 * 大頭照 1:1 圓形裁切
 *
 * 為什麼要裁：家長端小卡的頭像是 h-14 w-14 的圓形。教練隨手上傳的直式全身照
 * 直接塞進去，臉會被切掉或整個人變成一顆小點。與其在 CSS 用 object-cover 賭
 * 主體剛好在中間，不如讓教練自己決定框哪裡。
 *
 * 輸出固定 512×512 JPEG —— 顯示只要 56px，但家長端日後放大或改版時還有餘裕，
 * 而且 512 的 JPEG 約 40～80KB，比原檔小一個數量級。
 *
 * 數學：以「覆蓋整個取景框」為基準倍率，使用者的 zoom 疊在上面。位移一律夾在
 * 「圖片仍覆蓋整個取景框」的範圍內 —— 允許拖出白邊的話，輸出就會有透明或黑邊。
 */

const VIEW = 264;      // 取景框邊長（螢幕像素）
const OUT = 512;       // 輸出邊長
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

export default function AvatarCropper({ file, onCancel, onConfirm }) {
  const [url, setUrl] = useState('');
  const [nat, setNat] = useState(null);          // { w, h }
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const imgRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    if (!file) return undefined;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // 基準倍率：短邊剛好蓋滿取景框。
  const base = nat ? Math.max(VIEW / nat.w, VIEW / nat.h) : 1;
  const scale = base * zoom;

  function clamp(next, s = scale) {
    if (!nat) return { x: 0, y: 0 };
    const maxX = Math.max(0, (nat.w * s - VIEW) / 2);
    const maxY = Math.max(0, (nat.h * s - VIEW) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }

  function onPointerDown(e) {
    if (!nat) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, ox: off.x, oy: off.y };
  }
  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    setOff(clamp({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }));
  }
  function onPointerUp(e) {
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }
  function onWheel(e) {
    if (!nat) return;
    e.preventDefault();
    changeZoom(zoom + (e.deltaY < 0 ? 0.12 : -0.12));
  }
  function changeZoom(next) {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    setZoom(z);
    // 縮小之後原本的位移可能讓圖片露出邊界，用「新倍率」重夾一次。
    setOff((o) => clamp(o, base * z));
  }

  async function handleConfirm() {
    const img = imgRef.current;
    if (!img || !nat || busy) return;
    setBusy(true);
    setErr('');
    try {
      // 取景框在原圖座標系的大小與左上角。
      const srcSize = VIEW / scale;
      const cx = nat.w / 2 - off.x / scale;
      const cy = nat.h / 2 - off.y / scale;
      const canvas = document.createElement('canvas');
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext('2d');
      // 白底：輸出是 JPEG，沒有 alpha，透明區域不填會變成黑色。
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, OUT, OUT);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, cx - srcSize / 2, cy - srcSize / 2, srcSize, srcSize, 0, 0, OUT, OUT);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
      if (!blob) throw new Error('裁切失敗，請換一張圖試試');
      onConfirm(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    } catch (e) {
      setErr(e?.message || '裁切失敗');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" role="dialog" aria-modal="true" aria-label="裁切大頭照">
      <div className="w-full max-w-sm rounded-t-2xl bg-white p-4 sm:rounded-2xl">
        <div className="mb-1 text-base font-bold text-brand-primary">調整大頭照</div>
        <p className="mb-3 text-[11px] leading-5 text-gray-500">
          拖曳移動、滑桿縮放。建議用清晰的個人半身照，避免全身遠景 —— 家長看到的只有這個小圓圈。
        </p>

        <div
          className="relative mx-auto touch-none overflow-hidden rounded-xl bg-gray-900"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          {url && (
            <img
              ref={imgRef}
              src={url}
              alt=""
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                setNat({ w: el.naturalWidth, h: el.naturalHeight });
                setOff({ x: 0, y: 0 });
                setZoom(1);
              }}
              onError={() => setErr('這張圖讀不起來，請換一張')}
              className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
              style={{
                width: nat ? nat.w * scale : 'auto',
                height: nat ? nat.h * scale : 'auto',
                transform: `translate(-50%, -50%) translate(${off.x}px, ${off.y}px)`,
              }}
            />
          )}
          {/* 圓形輔助遮罩：外圈壓暗，內圈保持清楚。用 box-shadow 打洞，
              不用兩層 div —— 兩層在 iOS Safari 上邊緣會有 1px 白線。 */}
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 rounded-full border-2 border-white/80"
            style={{
              width: VIEW - 16,
              height: VIEW - 16,
              transform: 'translate(-50%, -50%)',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
            }}
          />
        </div>

        <div className="mt-3 flex items-center gap-3">
          <span className="text-xs text-gray-400">縮小</span>
          <input
            type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.01} value={zoom}
            onChange={(e) => changeZoom(Number(e.target.value))}
            className="min-w-0 flex-1 accent-brand-teal"
            aria-label="縮放"
          />
          <span className="text-xs text-gray-400">放大</span>
        </div>

        {err && <p className="mt-2 text-xs font-bold text-brand-error">{err}</p>}

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={onCancel} disabled={busy}
            className="rounded-lg border border-gray-300 py-2.5 text-sm font-bold text-gray-600 disabled:opacity-50">取消</button>
          <button type="button" onClick={handleConfirm} disabled={busy || !nat}
            className="rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white disabled:opacity-50">
            {busy ? '處理中…' : '使用這張'}
          </button>
        </div>
      </div>
    </div>
  );
}
