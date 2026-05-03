import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import liff from '@line/liff';
import App from './App';
import './index.css';

const LIFF_ID_PARENT = import.meta.env.VITE_LIFF_ID_PARENT || import.meta.env.VITE_LIFF_ID;
const LIFF_ID_COACH = import.meta.env.VITE_LIFF_ID_COACH || import.meta.env.VITE_LIFF_ID;

function pickLiffId() {
  const path = window.location.pathname || '';
  const isCoach = path.startsWith('/liff/coach') || path.startsWith('/coach');
  return isCoach ? LIFF_ID_COACH : LIFF_ID_PARENT;
}

function mount() {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <BrowserRouter basename="/liff">
      <App />
    </BrowserRouter>
  );
}

async function initLiff() {
  const liffId = pickLiffId();
  if (!liffId) {
    // eslint-disable-next-line no-console
    console.warn('[liff] VITE_LIFF_ID_PARENT / VITE_LIFF_ID_COACH 都未設定，跳過 liff.init（dev / mock 模式）');
    mount();
    return;
  }

  try {
    await liff.init({ liffId });
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
