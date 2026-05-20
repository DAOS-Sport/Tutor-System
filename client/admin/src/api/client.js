import axios from 'axios';

export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

const TOKEN_KEY = 'daos.admin.user';

function readToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u && u.token ? u.token : null;
  } catch {
    return null;
  }
}

export const http = axios.create({
  baseURL: '/api/admin',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

// 每次呼叫前自動掛 Bearer token（前端 AuthContext 把 user/token 存在 localStorage）
http.interceptors.request.use((config) => {
  const token = readToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 401（token 失效）→ 清掉本地 user 並導回登入
//
// Task #68：背景輪詢（如 Sidebar 的 ragic-staging/count）使用 config.skipAuthRedirect = true
// 即可在 401 時只丟 reject、不強制 window.location.href 跳轉，避免使用者
// 在頁面上正常操作時被「無預警踢回登入」。互動式請求（login/表單）仍走預設行為。
//
// Task #70：RagicStatusPage / RagicStagingPage 的所有 API 呼叫也使用此 flag，
// 讓 401/500 timeout 只在頁面顯示 toast + 重試按鈕，不清除 session。
// 判斷準則：
//   - 頁面互動動作（寫表單、登入）→ 不加 flag，走預設全域踢出
//   - 背景輪詢 / Ragic 狀態頁 API → 加 skipAuthRedirect: true
let _redirectingOn401 = false; // 模組級 dedupe，避免短時間多支互動 API 同時 401 觸發 N 次 redirect
http.interceptors.response.use(
  (res) => res,
  (err) => {
    // Task #88：把後端兜底 404「admin endpoint not found」改寫成可定位的友善訊息。
    // 6 個後台頁的 catch 都是 `toast.error(e.response.data.error || e.message)`，
    // 改寫 response.data.error 即可全頁面套用，不需要逐頁改。
    // 最常見成因 = 使用者瀏覽器卡在舊版 SPA bundle，所以提示「請重新整理頁面」。
    if (err?.response?.status === 404 && err?.response?.data?.error === 'admin endpoint not found') {
      const path = err?.response?.data?.path || err?.config?.url || '(unknown)';
      try {
        err.response.data.error = `找不到 API：${path}（請重新整理頁面以取得最新版本）`;
        // eslint-disable-next-line no-console
        console.warn('[admin api 404]', err?.config?.method?.toUpperCase(), path, '— 建議使用者重新整理');
      } catch { /* noop */ }
    }
    if (err?.response?.status === 401) {
      const skip = err?.config?.skipAuthRedirect === true;
      try {
        if (!skip && !_redirectingOn401) {
          _redirectingOn401 = true;
          localStorage.removeItem(TOKEN_KEY);
          if (
            typeof window !== 'undefined' &&
            !window.location.pathname.endsWith('/login')
          ) {
            // 在 LoginPage 顯示一次「請重新登入」toast（透過 sessionStorage 跨頁傳遞，
            // LoginPage 掛載時讀取並 pop 掉），避免使用者覺得「無預警被踢回」。
            try { sessionStorage.setItem('daos.admin.flashLogout', '1'); } catch { /* noop */ }
            window.location.href = '/admin/login';
          } else {
            // 已在 login 頁，flag 解除讓下次 401 仍可正常處理
            _redirectingOn401 = false;
          }
        }
      } catch { /* noop */ }
    }
    return Promise.reject(err);
  }
);

function delay(value, ms = 240) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * 統一入口：
 * - mock 模式（VITE_USE_MOCK 未設或 = 'true'）→ 直接打 mockFn
 * - 真實模式 → 打 axios；遇到 501（後端 stub）才 fallback 到 mockFn，並 console.warn
 */
export async function callApi(path, options = {}, mockFn) {
  const { method = 'get', data, params } = options;

  if (USE_MOCK) {
    return delay(typeof mockFn === 'function' ? mockFn() : mockFn);
  }

  try {
    const res = await http.request({ url: path, method, data, params });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 501 && typeof mockFn === 'function') {
      // eslint-disable-next-line no-console
      console.warn(`[admin api] ${method.toUpperCase()} /api/admin${path} → 501 stub，回退到 mock`);
      return delay(mockFn());
    }
    throw err;
  }
}
