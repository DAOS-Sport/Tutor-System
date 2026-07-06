import axios from 'axios';
import liff from '@line/liff';

// P0.1 fail-safe：只有明確 VITE_USE_MOCK === 'true' 才啟用 mock（正式環境預設走真實 API）。
export const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

// 一律走相對路徑（部署時走同源），開發時 vite proxy 已將 /api 轉到 :3000
export const http = axios.create({
  baseURL: '/api',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

const USER_KEY = 'daos.user';
let redirectingOn401 = false;
let reauthPromise = null; // single-flight：多個並發 401 共用同一次靜默重驗

function normalizeAppPath(pathname) {
  const path = String(pathname || '/');
  return path.replace(/^\/liff(?=\/|$)/, '') || '/';
}

function isAuthBootstrapPath() {
  if (typeof window === 'undefined') return false;
  const path = normalizeAppPath(window.location.pathname || '/');
  return path === '/login' || path === '/register' || path === '/demo' || path === '/coach-portal';
}

function apiPathFromUrl(url) {
  const raw = String(url || '');
  if (!raw) return '';
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const path = new URL(raw, base).pathname;
    return path.replace(/^\/api(?=\/|$)/, '') || '/';
  } catch {
    return raw.replace(/^\/api(?=\/|$)/, '') || '/';
  }
}

function isAuthBootstrapRequest(url) {
  const path = apiPathFromUrl(url);
  return path === '/auth' || path.startsWith('/auth/');
}

// 靜默重新驗證（家長）：用目前 LINE session 的 id_token 換一顆新的 app JWT，寫回 localStorage。
// 目的：token 過期造成的 401 不要把人登出，先在背景換新的、讓原請求重試，使用者無感。
// 重點：
//  - 用原生 axios（不走 http 實例）呼叫後端，避免再次觸發本回應攔截器造成無限遞迴。
//  - 回傳的 parent 去敏後才落地（line_uid 不寫進 localStorage，與 AuthContext._stripSensitive 一致）。
//  - 只有後端回 status:'logged_in' 且拿到 token 才算成功；need_phone_binding 等狀態視為失敗（需走登入頁）。
function silentReauthParent() {
  if (reauthPromise) return reauthPromise;
  reauthPromise = (async () => {
    let idToken = null;
    try { if (liff && liff.isLoggedIn && liff.isLoggedIn()) idToken = liff.getIDToken(); } catch { /* 非 LINE 環境 */ }
    if (!idToken) return false;
    let data;
    try {
      const res = await axios.post('/api/auth/parent-line-login', { id_token: idToken },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
      data = res?.data;
    } catch { return false; }
    const token = data?.token || data?.parent?.token;
    if (data?.status !== 'logged_in' || !token) return false;
    try {
      const p = data.parent || {};
      const { line_uid, lineUid, token: _t, ...safe } = p;
      localStorage.setItem(USER_KEY, JSON.stringify({ role: 'parent', data: safe, token }));
    } catch { return false; }
    return true;
  })().finally(() => { reauthPromise = null; });
  return reauthPromise;
}

// 自動為每筆請求附上目前登入者的 JWT（教練 / 家長皆同；mock 模式不會走到這裡）
http.interceptors.request.use((config) => {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) {
      const u = JSON.parse(raw);
      const tk = u?.token || u?.data?.token;
      if (tk) {
        config.headers = config.headers || {};
        config.headers.Authorization = `Bearer ${tk}`;
      }
    }
  } catch { /* localStorage 不可用時略過 */ }
  // 上傳檔案（FormData）：移除實例預設的 application/json，
  // 否則 axios 不會自動補上 multipart/form-data 的 boundary，後端 multer 收不到檔案
  // （症狀：上傳匯款證明 / 發票 / 授課媒體時被退「請選擇檔案」）。
  if (typeof FormData !== 'undefined' && config.data instanceof FormData && config.headers) {
    if (typeof config.headers.delete === 'function') config.headers.delete('Content-Type');
    else delete config.headers['Content-Type'];
  }
  return config;
});

http.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err?.response?.status !== 401) return Promise.reject(err);
    const config = err.config || {};

    // 登入、電話綁定、註冊流程本身會用 401 表示 LINE token 逾期/驗證失敗；
    // 這些錯誤必須交給頁面層處理（LoginPage 有單次 liff.login 刷新守衛），
    // 不能被全域攔截器搶先導回 /login，否則使用者會在電話/註冊頁看到 relogin loop。
    if (config.skipAuthRedirect || isAuthBootstrapRequest(config.url) || isAuthBootstrapPath()) {
      return Promise.reject(err);
    }

    // 先記住「是不是教練」，決定後續行為與導向。
    let wasCoach = false;
    try {
      const raw = localStorage.getItem(USER_KEY);
      if (raw) { try { wasCoach = JSON.parse(raw)?.role === 'coach'; } catch { /* noop */ } }
    } catch { /* noop */ }

    // ── 家長：先「靜默重新驗證 + 重試原請求」，不自動登出（尊重使用者需求）──
    // 只重試一次（config._retriedAfterReauth 守衛），避免新 token 仍 401 造成無限重試。
    if (!wasCoach && !config._retriedAfterReauth) {
      let ok = false;
      try { ok = await silentReauthParent(); } catch { ok = false; }
      if (ok) {
        config._retriedAfterReauth = true;
        return http.request(config); // request 攔截器會自動帶上剛換到的新 token
      }
    }

    // ── 走到這裡代表：重驗失敗 / 是教練 / 已重試過一次 → 失敗才提示 + 導去登入 ──
    if (!redirectingOn401) {
      redirectingOn401 = true;
      try {
        sessionStorage.setItem('daos.liff.flashLogout', '1'); // 登入頁會讀這個顯示「階段過期，請重新登入」
        // 教練維持原行為：清 session，回教練登入頁（portal token 會靜默續登）。
        // 家長：**不主動清 session**（不自動登出人），交給登入頁重新 LINE 驗證；
        //       若重新驗證成功會覆蓋 session，失敗才會停在登入頁顯示可讀錯誤。
        if (wasCoach) {
          localStorage.removeItem(USER_KEY);
          localStorage.removeItem('daos.manualLogout');
        }
      } catch { /* noop */ }
      if (typeof window !== 'undefined') {
        const path = window.location.pathname || '';
        const host = window.location.hostname || '';
        const inLiff = path.startsWith('/liff');
        // 教練 session 過期：一律回教練登入頁 /coach-portal（會用 30 天 portal token 靜默續登，
        // 不行才顯示 LINE 登入鈕）。絕不可導去家長 /login 或 demo —— 那會把教練困進家長 LIFF
        // 流程造成卡死/死迴圈，且無法排查。
        const isCoachCtx = wasCoach || /\/coach(\b|\/|$)/.test(path);
        if (isCoachCtx) {
          window.location.replace(inLiff ? '/liff/coach-portal' : '/coach-portal');
        } else {
          const isDemoHost = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.replit.dev') || host.endsWith('.repl.co');
          const demoPath = inLiff ? '/liff/demo' : '/demo';
          const loginPath = inLiff ? '/liff/login' : '/login';
          window.location.replace(isDemoHost || path.includes('/demo') ? demoPath : loginPath);
        }
      }
    }
    return Promise.reject(err);
  }
);

// 模擬網路延遲，讓 LoadingSpinner 真的有機會出現
function delay(value, ms = 280) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * 對外統一入口：
 * - mock 模式：直接執行 mockFn() 並包成 Promise
 * - 真實模式：呼叫後端，若收到 501（stub）→ 自動 fallback 到 mockFn
 */
export async function callApi(path, options = {}, mockFn) {
  const { method = 'get', data, params, headers, skipAuthRedirect = false } = options;

  if (USE_MOCK) {
    return delay(typeof mockFn === 'function' ? mockFn() : mockFn);
  }

  try {
    const res = await http.request({ url: path, method, data, params, headers, skipAuthRedirect });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 501 && import.meta.env.DEV && typeof mockFn === 'function') {
      // eslint-disable-next-line no-console
      console.warn(`[api] ${method.toUpperCase()} ${path} → 501 stub，回退到 mock（僅 dev）`);
      return delay(mockFn());
    }
    throw err;
  }
}
