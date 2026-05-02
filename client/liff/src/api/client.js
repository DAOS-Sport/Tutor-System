import axios from 'axios';

// 預設啟用 mock；要切真實 API 在 build / dev 時加 VITE_USE_MOCK=false
export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

// 一律走相對路徑（部署時走同源），開發時 vite proxy 已將 /api 轉到 :3000
export const http = axios.create({
  baseURL: '/api',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

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
      console.warn(`[api] ${method.toUpperCase()} ${path} → 501 stub，回退到 mock`);
      return delay(mockFn());
    }
    throw err;
  }
}
