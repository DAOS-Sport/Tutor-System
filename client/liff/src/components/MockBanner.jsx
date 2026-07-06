import React from 'react';
import { USE_MOCK } from '../api/client';

// P0.1：mock 模式全域醒目橫幅，避免把假資料誤認為真實資料。
// 只有明確 VITE_USE_MOCK==='true' 時 USE_MOCK 才為真，正式 build 不會顯示。
export default function MockBanner() {
  if (!USE_MOCK) return null;
  return (
    <div
      role="alert"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        background: '#b91c1c', color: '#fff', textAlign: 'center',
        fontWeight: 700, fontSize: 12, letterSpacing: '.03em',
        padding: '3px 8px', boxShadow: '0 1px 4px rgba(0,0,0,.35)',
      }}
    >
      ⚠️ MOCK MODE — 非真實資料
    </div>
  );
}
