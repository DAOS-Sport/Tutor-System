import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { clearAfterAuth } from '../utils/afterAuth';

/**
 * 同時支援家長 / 教練兩種角色：
 *  - storage key 'daos.user' 內存 { role: 'parent'|'coach', data: {...} }
 *  - 為向後相容，仍對外暴露 `parent` / `setParent`（家長場景沿用），
 *    教練場景另外用 `coach` / `setCoach`
 */
const AuthContext = createContext(null);
const STORAGE_KEY = 'daos.user';
const DAOS_MANUAL_LOGOUT_KEY = 'daos.manualLogout';

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function save(u) {
  if (u) localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
  else localStorage.removeItem(STORAGE_KEY);
}

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(() => load());

  const setUser = (u) => {
    if (u) localStorage.removeItem(DAOS_MANUAL_LOGOUT_KEY);
    setUserState(u);
    save(u);
  };
  // 統一去敏：line_uid 是身分綁定中介，前端只需要 token + 身分資料；
  // 不應落地到 localStorage，避免在客戶端被讀取或誤用為登入憑證。
  const _stripSensitive = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const { line_uid, lineUid, ...rest } = obj;
    return rest;
  };
  // coach 物件的 token 拉到頂層 (供 axios interceptor 直接讀)，data 仍保留全欄位（去敏後）
  const setParent = (p) => setUser(p ? { role: 'parent', data: _stripSensitive(p), token: p?.token || null } : null);
  const setCoach  = (c) => setUser(c ? { role: 'coach',  data: _stripSensitive(c), token: c?.token || null } : null);
  const logout    = () => {
    localStorage.setItem(DAOS_MANUAL_LOGOUT_KEY, '1');
    // 清除殘留的登入後回跳路徑（可能是上一個團購 join 連結），
    // 避免下次自動登入被帶回舊團（會看起來像「加入別人的團」）。
    clearAfterAuth();
    setUser(null);
  };

  useEffect(() => {
    function onStorage(e) {
      if (e.key === STORAGE_KEY) setUserState(e.newValue ? JSON.parse(e.newValue) : null);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo(() => ({
    user,
    role: user?.role || null,
    parent: user?.role === 'parent' ? user.data : null,
    coach:  user?.role === 'coach'  ? user.data : null,
    isAuthed: !!user,
    setUser, setParent, setCoach, logout,
  }), [user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
