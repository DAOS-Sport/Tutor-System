import axios from 'axios';

// 預設啟用 mock；要切真實 API 在 build / dev 時加 VITE_USE_MOCK=false
export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

// 一律走相對路徑（部署時走同源），開發時 vite proxy 已將 /api 轉到 :3000
export const http = axios.create({
  baseURL: '/api',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

const USER_KEY = 'daos.user';
let redirectingOn401 = false;

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
  (err) => {
    if (err?.response?.status === 401 && !redirectingOn401) {
      redirectingOn401 = true;
      try {
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem('daos.manualLogout');
        sessionStorage.setItem('daos.liff.flashLogout', '1');
      } catch { /* noop */ }
      if (typeof window !== 'undefined') {
        const path = window.location.pathname || '';
        const host = window.location.hostname || '';
        const isDemoHost = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.replit.dev') || host.endsWith('.repl.co');
        const demoPath = path.startsWith('/liff') ? '/liff/demo' : '/demo';
        const loginPath = path.startsWith('/liff') ? '/liff/login' : '/login';
        window.location.replace(isDemoHost || path.includes('/demo') ? demoPath : loginPath);
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
  const { method = 'get', data, params, headers } = options;

  if (USE_MOCK) {
    return delay(typeof mockFn === 'function' ? mockFn() : mockFn);
  }

  try {
    const res = await http.request({ url: path, method, data, params, headers });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 501 && typeof mockFn === 'function') {
      // eslint-disable-next-line no-console
      console.warn(`[api] ${method.toUpperCase()} ${path} → 501 stub，回退到 mock`);
      return delay(mockFn());
    }
    throw err;
  }
}
