import React, { lazy } from 'react';
import { importWithRetry } from './chunkRetry.js';

/**
 * 路由層級的程式碼切分（#15 第 3 步），後台與家長端共用。
 *
 * 跟 React.lazy 一樣用，差別在 chunk 載不到時會先重試、再重新整理一次，
 * 不讓「部署後還開著舊頁面」的人卡在錯誤頁。策略與理由見 ./chunkRetry.js。
 */
export function lazyPage(importer) {
  return lazy(() => importWithRetry(importer));
}

/**
 * 頁面 chunk 還在下載時的畫面。刻意用 inline style（不靠 Tailwind）：
 * CSS 若也還沒到，至少文字要看得到，不能是一片空白。
 */
export function PageLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: '10px', padding: '48px 16px', color: '#64748b', fontSize: '14px',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '18px', height: '18px', borderRadius: '50%',
          border: '2px solid #cbd5e1', borderTopColor: '#15316a',
          animation: 'daos-page-spin 0.8s linear infinite',
        }}
      />
      <span>載入中…</span>
      <style>{'@keyframes daos-page-spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}
