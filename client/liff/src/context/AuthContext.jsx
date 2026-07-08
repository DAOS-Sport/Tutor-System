import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { clearAfterAuth } from '../utils/afterAuth';
import { parentsApi } from '../api/parents';
import { cleanVenueList } from '../utils/venues';

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
  const _normalizeCoach = (obj) => {
    const safe = _stripSensitive(obj);
    if (!safe || typeof safe !== 'object') return safe;
    const venueIds = cleanVenueList(safe.venue_ids || safe.venues || []);
    return { ...safe, venue_ids: venueIds, venues: venueIds };
  };
  // coach 物件的 token 拉到頂層 (供 axios interceptor 直接讀)，data 仍保留全欄位（去敏後）
  const setParent = (p) => setUser(p ? { role: 'parent', data: _stripSensitive(p), token: p?.token || null } : null);
  const setCoach  = (c) => setUser(c ? { role: 'coach',  data: _normalizeCoach(c), token: c?.token || null } : null);
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

  // 開啟 App 即向資料庫重新請求一次（每次掛載只跑一次）：已登入家長不吃 localStorage
  // 舊快取，主動打 POST /parents/me/sync 取最新家長＋學員鏡像（後端有節流與失敗降級，
  // Ragic 失敗也會回 DB 鏡像）。token 過期 → 401 由 api/client.js 靜默重驗攔截器換新
  // token 並重試，使用者無感。失敗一律靜默（開頁刷新不是硬性門檻，不打擾使用者）。
  useEffect(() => {
    const u = load();
    if (!u || u.role !== 'parent' || !u.token) return;
    let cancelled = false;
    parentsApi.sync()
      .then((me) => {
        if (cancelled || !me || !me.id) return;
        setUserState((prev) => {
          if (!prev || prev.role !== 'parent') return prev;
          const { line_uid, lineUid, sync_status, ...safe } = me;
          // 401 interceptor 可能已靜默換新 token 並先寫入 localStorage；
          // 這裡合併資料時以最新 storage 為底，避免把舊 token 寫回去。
          const latest = load();
          const base = latest && latest.role === 'parent' ? latest : prev;
          const next = { ...base, data: { ...base.data, ...safe } };
          save(next);
          return next;
        });
      })
      .catch(() => { /* 靜默：401 攔截器已處理換 token；其餘留給頁面層各自請求 */ });
    return () => { cancelled = true; };
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
