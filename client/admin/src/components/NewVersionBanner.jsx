import React, { useState } from 'react';
import { useSpaVersionCheck } from '../hooks/useSpaVersionCheck';

// Task #88：偵測到 server 端 bundle hash 變更時，於頁面頂端顯示提示條。
// 不強制 reload（使用者可能正在編輯表單），只提供「重新載入」按鈕 + 可關閉。
export default function NewVersionBanner() {
  const { outdated, reload } = useSpaVersionCheck();
  const [dismissed, setDismissed] = useState(false);

  if (!outdated || dismissed) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-brand-teal/30 bg-brand-teal/10 px-4 py-2 text-sm text-brand-primary">
      <span>
        <span className="font-bold">系統已更新</span>
        ：建議重新載入以取得最新功能與修復。如果您正在編輯資料，請先儲存再點重新載入。
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={reload}
          className="rounded-md bg-brand-teal px-3 py-1 text-xs font-bold text-white hover:bg-brand-primary"
        >
          重新載入
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-md border border-brand-teal/40 px-2 py-1 text-xs text-brand-primary hover:bg-white"
          aria-label="關閉提示"
        >
          稍後
        </button>
      </span>
    </div>
  );
}
