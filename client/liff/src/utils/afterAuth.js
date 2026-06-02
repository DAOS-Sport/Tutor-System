// 登入/註冊完成後要返回的路徑（例如從團購加入連結進來、需先登入時）。
// 存 localStorage 以跨越 LIFF 登入 redirect 與 /login → /register 的多次頁面跳轉。
const KEY = 'daos.afterAuth';

export function setAfterAuth(path) {
  try { if (path) localStorage.setItem(KEY, path); } catch { /* noop */ }
}

// 取出並清除；沒有則回傳 fallback（預設首頁）
export function takeAfterAuth(fallback = '/') {
  try {
    const v = localStorage.getItem(KEY);
    if (v) { localStorage.removeItem(KEY); return v; }
  } catch { /* noop */ }
  return fallback;
}
