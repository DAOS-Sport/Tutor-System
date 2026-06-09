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

// 教練端 path：/liff/coach 或 /liff/coach/...（無 basename 時為 /coach）。
// 用 word-boundary 比對，避免把家長的「選教練」頁 /liff/coaches 誤判成教練端，
// 否則家長在 /coaches 觸發登入會被 init 成教練 LIFF → 被當教練（議題2 路由 bug）。
// 與 LoginPage.jsx::isCoachLiffContext 的正則保持一致。
function isCoachPath() {
  const path = window.location.pathname || '';
  return /\/coach(\b|\/|$)/.test(path);
}

// Demo 功能測試頁：以一般瀏覽器（非 LINE）開啟，需略過 liff.init / liff.login，
// 否則 production 下未登入 LINE 會被導去 LINE OAuth，無法用帳密測試。
function isDemoPath() {
  const path = window.location.pathname || '';
  const search = window.location.search || '';
  // /liff/demo、/demo，或任何帶 ?demo=1 的路徑（如 Demo 測試註冊的 /register?demo=1）
  // 都略過 liff.init，讓沒有 LINE 帳號者能在一般瀏覽器測試（含重新整理不被導去 LINE）。
  return path === '/liff/demo' || path === '/demo' || /[?&]demo=1(?:&|$)/.test(search);
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
  // 教練端（/coach、/coach-portal）走自己的 web OAuth（/api/coach-portal），
  // 完全不依賴 LIFF SDK。若仍跑 liff.init/liff.login，未登入的教練會被強制導去 LINE，
  // 回來又無 LIFF session → 再次被導去 → 無限跳轉（手機 LINE 內 / 電腦瀏覽器皆會）。
  // 故教練路徑一律跳過 LIFF，交由 CoachPortalLoginPage 的 OAuth/portal-token 流程處理。
  if (isCoachPath()) {
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
