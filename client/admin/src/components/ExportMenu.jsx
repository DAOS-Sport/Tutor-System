import React, { useEffect, useRef, useState } from 'react';

// 通用「匯出 ▾」下拉選單；同時提供 CSV 與 XLSX 兩種格式。
export default function ExportMenu({ disabled, onExportCsv, onExportXlsx, label = '匯出' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // disabled 翻為 true 時自動關閉，避免 stale-open 造成的雙擊感
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  function pick(fn) {
    setOpen(false);
    fn?.();
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        /* px-4 py-2 text-sm 實高約 36px。手機上這顆與下面兩個選項擠在一起，
           36px 的命中區在池畔濕手操作時很容易點成隔壁項；md 以上是滑鼠，維持原密度。 */
        className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0"
      >
        {label} <span aria-hidden>▾</span>
      </button>
      {open && !disabled && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-32 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(onExportCsv)}
            /* 兩個選項各約 36px、上下相黏，手機上點 CSV 很容易落到 XLSX。
               44px 是可靠命中的下限；桌機不動。 */
            className="flex min-h-[44px] w-full items-center px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 md:min-h-0"
          >
            CSV
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(onExportXlsx)}
            className="flex min-h-[44px] w-full items-center px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 md:min-h-0"
          >
            XLSX
          </button>
        </div>
      )}
    </div>
  );
}
