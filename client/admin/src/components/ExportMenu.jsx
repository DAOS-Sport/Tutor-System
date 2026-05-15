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
        className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:cursor-not-allowed disabled:opacity-50"
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
            className="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            CSV
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(onExportXlsx)}
            className="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            XLSX
          </button>
        </div>
      )}
    </div>
  );
}
