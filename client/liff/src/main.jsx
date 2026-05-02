import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import liff from '@line/liff';
import App from './App';
import './index.css';

const LIFF_ID = import.meta.env.VITE_LIFF_ID;

function mount() {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <BrowserRouter basename="/liff">
      <App />
    </BrowserRouter>
  );
}

async function initLiff() {
  // Phase 1 fallback：若沒設定 LIFF_ID（例如本機 vite dev / 預覽建置），
  // 直接 mount，由 mock auth 流程接手；未來真實上線時 LIFF_ID 會在 build env 注入。
  if (!LIFF_ID) {
    // eslint-disable-next-line no-console
    console.warn('[liff] VITE_LIFF_ID 未設定，跳過 liff.init（dev / mock 模式）');
    mount();
    return;
  }

  try {
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: window.location.href });
      return;
    }
    mount();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[liff] init 失敗，退回到無 LIFF 模式：', err);
    mount();
  }
}

initLiff();
