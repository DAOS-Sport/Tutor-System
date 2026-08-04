import React from 'react';
import { formatTWDateTime } from '../../utils/format';

/**
 * 批量新增結果摘要 modal（規格：批量結果應有專屬摘要而非 toast）
 * result: { created, skipped, errors?: [{ start_at, error }] }
 */
export default function BatchResultModal({ result, onClose }) {
  const errs = Array.isArray(result.errors) ? result.errors : [];
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-6" onClick={onClose}>
      <div className="w-full max-w-[340px] rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-bold text-brand-primary">批量建立完成</h3>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-lg bg-brand-green/10 py-3">
            <div className="text-xs text-gray-500">已建立</div>
            <div className="text-2xl font-bold text-brand-green">{result.created ?? 0}</div>
          </div>
          <div className="rounded-lg bg-gray-100 py-3">
            <div className="text-xs text-gray-500">跳過</div>
            <div className="text-2xl font-bold text-gray-500">{result.skipped ?? 0}</div>
          </div>
        </div>
        {errs.length > 0 && (
          <div className="mt-3 max-h-32 overflow-y-auto rounded-lg border border-red-100 bg-red-50 p-2 text-[11px] text-red-700">
            <div className="mb-1 font-semibold">{errs.length} 筆錯誤：</div>
            <ul className="space-y-0.5">
              {errs.slice(0, 5).map((e, i) => (
                <li key={i}>· {e.start_at ? formatTWDateTime(e.start_at) : ''} — {e.error}</li>
              ))}
              {errs.length > 5 && <li>… 等 {errs.length - 5} 筆</li>}
            </ul>
          </div>
        )}
        <button onClick={onClose}
          className="mt-4 w-full rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white active:bg-brand-teal">
          完成
        </button>
      </div>
    </div>
  );
}
