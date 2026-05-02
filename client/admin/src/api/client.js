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
http.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401) {
      try {
        localStorage.removeItem(TOKEN_KEY);
        if (typeof window !== 'undefined' && !window.location.pathname.endsWith('/login')) {
          window.location.href = '/admin/login';
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
