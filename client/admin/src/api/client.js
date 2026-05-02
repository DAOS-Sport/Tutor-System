import axios from 'axios';

export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

export const http = axios.create({
  baseURL: '/api/admin',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

function delay(value, ms = 240) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * 統一入口：mock 模式直接打 mockFn；真實模式遇到 501 自動 fallback 到 mockFn。
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
