import React, { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

/**
 * 橫列式（1D）條碼。預設 CODE39 —— 台灣電子發票「手機條碼載具」標準編碼，
 * 供櫃檯開發票時用條碼槍掃描，減少手動輸入錯誤。
 * 字元不合法（CODE39 僅接受大寫英數與 - . $ / + % 空白）時留白，不破版。
 */
export default function Barcode({ value, format = 'CODE39', height = 50 }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !value) return;
    try {
      JsBarcode(el, String(value).toUpperCase(), {
        format,
        height,
        displayValue: true,
        fontSize: 13,
        margin: 4,
        background: '#ffffff',
      });
    } catch {
      el.innerHTML = '';
    }
  }, [value, format, height]);
  if (!value) return null;
  return <svg ref={ref} className="max-w-full" />;
}
