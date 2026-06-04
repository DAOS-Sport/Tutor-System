import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import liff from '@line/liff';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

const LIFF_ID_PARENT = import.meta.env.VITE_LIFF_ID_PARENT || import.meta.env.VITE_LIFF_ID;
const LIFF_ID_COACH = import.meta.env.VITE_LIFF_ID_COACH || import.meta.env.VITE_LIFF_ID;
const HAS_DISTINCT_COACH_LIFF =
  !!LIFF_ID_PARENT && !!LIFF_ID_COACH && String(LIFF_ID_PARENT) !== String(LIFF_ID_COACH);

function isCoachLiffId(id) {
  return HAS_DISTINCT_COACH_LIFF && !!id && String(id) === String(LIFF_ID_COACH);
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

// 是否已有本地登入 session（含 demo 登入）。AuthContext 以 'daos.user' 存
// { role, data, token }；有 token 即視為已登入。
function hasLocalSession() {
  try {
    const raw = localStorage.getItem('daos.user');
    if (!raw) return false;
    const u = JSON.parse(raw);
    return !!(u && u.token);
  } catch {
    return false;
  }
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
      // 測試/瀏覽器例外：非 LINE App 內（!isInClient）且已有本地 session（含 demo 登入）時，
      // 不強制跳 LINE，直接用既有 session 掛載——讓單人能在瀏覽器自測團購加入等流程。
      // LINE App 內行為完全不變（仍強制 LINE 登入）；後端登入仍驗 id_token，安全不受影響。
      let inClient = true;
      try { inClient = !!liff.isInClient(); } catch { inClient = false; }
      if (!inClient && hasLocalSession()) {
        mount();
        return;
      }
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
