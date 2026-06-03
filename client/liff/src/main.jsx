import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import liff from '@line/liff';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

const LIFF_ID_PARENT = import.meta.env.VITE_LIFF_ID_PARENT || import.meta.env.VITE_LIFF_ID;
const LIFF_ID_COACH = import.meta.env.VITE_LIFF_ID_COACH || import.meta.env.VITE_LIFF_ID;

function isCoachLiffId(id) {
  return !!id && !!LIFF_ID_COACH && String(id) === String(LIFF_ID_COACH);
}

function isCoachPath() {
  const path = window.location.pathname || '';
  return path.startsWith('/liff/coach') || path.startsWith('/coach');
}

// Demo 功能測試頁：以一般瀏覽器（非 LINE）開啟，需略過 liff.init / liff.login，
// 否則 production 下未登入 LINE 會被導去 LINE OAuth，無法用帳密測試。
function isDemoPath() {
  const path = window.location.pathname || '';
  return path === '/liff/demo' || path === '/demo';
}

function pickLiffId() {
  return isCoachPath() ? LIFF_ID_COACH : LIFF_ID_PARENT;
}

function normalizeCoachLanding() {
  const liffId = pickLiffId();
  try {
    const currentLiffId = liff?.id || liffId;
    if (isCoachLiffId(currentLiffId) && !isCoachPath()) {
      window.history.replaceState(null, '', '/liff/coach' + window.location.search);
    }
  } catch {
    if (isCoachLiffId(liffId) && !isCoachPath()) {
      window.history.replaceState(null, '', '/liff/coach' + window.location.search);
    }
  }
}

function mount() {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <ErrorBoundary>
      <BrowserRouter basename="/liff">
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  );
}

async function initLiff() {
  if (isDemoPath()) {
    // 直接掛載，不初始化 LIFF、不導 LINE 登入。
    mount();
    return;
  }
  const liffId = pickLiffId();
  if (!liffId) {
    // eslint-disable-next-line no-console
    console.warn('[liff] VITE_LIFF_ID_PARENT / VITE_LIFF_ID_COACH 都未設定，跳過 liff.init（dev / mock 模式）');
    mount();
    return;
  }

  try {
    await liff.init({ liffId });
    normalizeCoachLanding();
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: window.location.href });
      return;
    }
    mount();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[liff] init 失敗，退回到無 LIFF 模式：', err);
    normalizeCoachLanding();
    mount();
  }
}

initLiff();
