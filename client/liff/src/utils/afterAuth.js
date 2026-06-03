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

// 主動清除（不取值）。用於「不會走 takeAfterAuth 導向」的分支：
// 登出、登入失敗、手動登出守衛早退——避免殘留的舊團 join 路徑在
// 下次成功自動登入時被 takeAfterAuth 取用，把使用者帶去別人的舊團。
export function clearAfterAuth() {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}
