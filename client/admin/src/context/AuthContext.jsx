import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const AuthContext = createContext(null);
const STORAGE_KEY = 'daos.admin.user';

/**
 * Task #51（employees 表合併）：後端 /api/admin/auth/login 現在同時回
 *   - roles: ['system_admin'|'manager'|'counter', ...]   ← source of truth
 *   - role:  'admin'|'manager'|'staff'                    ← 舊 single-string shim（給現有 admin route 內 req.adminUser.role 用）
 * 前端以 roles[] 為主，但保留 role getter 回傳舊字串，避免散布在 13 頁的 `useAuth().role === 'admin'` 全部要改。
 *
 * 角色映射（與後端 adminAuth.deriveLegacyRole / LEGACY_TO_EMPLOYEE 一致）：
 *   system_admin ↔ admin
 *   manager      ↔ manager
 *   counter      ↔ staff
 */
const NEW_TO_LEGACY = {
  system_admin: 'admin',
  manager: 'manager',
  counter: 'staff',
};

/** 從 roles[] 推導舊 single-string role（優先順序：admin > manager > staff），找不到則 fallback 到 user.role 或 null。 */
function deriveLegacyRole(u) {
  if (!u) return null;
  const roles = Array.isArray(u.roles) ? u.roles : [];
  if (roles.includes('system_admin')) return 'admin';
  if (roles.includes('manager')) return 'manager';
  if (roles.includes('counter')) return 'staff';
  return u.role || null; // backward-compat: 舊 localStorage 內可能只有 role
}

/** 判斷 user 是否擁有某「新」role；同時相容 legacy 舊字串 role。 */
function hasRole(u, newRole) {
  if (!u) return false;
  const roles = Array.isArray(u.roles) ? u.roles : [];
  if (roles.includes(newRole)) return true;
  // legacy fallback：若 localStorage 內舊資料只有 user.role 字串
  const legacy = NEW_TO_LEGACY[newRole];
  return legacy && u.role === legacy;
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(() => loadFromStorage());

  const setUser = (u) => {
    setUserState(u);
    if (u) localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    else localStorage.removeItem(STORAGE_KEY);
  };

  const logout = () => setUser(null);

  useEffect(() => {
    function onStorage(e) {
      if (e.key === STORAGE_KEY) setUserState(e.newValue ? JSON.parse(e.newValue) : null);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo(
    () => ({
      user,
      isAuthed: !!user,
      // 新格式：source of truth；舊資料若沒 roles 欄位則退化成 [legacy] 單元素陣列
      roles: Array.isArray(user?.roles)
        ? user.roles
        : (user?.role ? [Object.entries(NEW_TO_LEGACY).find(([, l]) => l === user.role)?.[0] || user.role] : []),
      // 舊 single-string shim：避免散布在 13 頁的 `role === 'admin'/'manager'/'staff'` 寫法全壞
      role: deriveLegacyRole(user),
      isAdmin: hasRole(user, 'system_admin'),
      isManager: hasRole(user, 'manager'),
      isStaff: hasRole(user, 'counter'),
      setUser,
      logout,
    }),
    [user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
