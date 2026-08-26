import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { rolePermissionsApi } from '../api/rolePermissions';

/**
 * 目前登入者看得到哪些頁面（F-A06）。
 *
 * 在此之前，選單與路由守衛各自寫死一份 roles 陣列，而後端閘門又是第三份。
 * 三份東西描述同一件事卻沒有任何機制保證它們一致 —— 於是「畫面上看不到」
 * 跟「真的不能用」永遠可能對不上。這裡讓前端兩層都讀同一份後端資料。
 *
 * loading 期間一律當作「還不知道」而不是「沒有權限」：把載入中畫成無權限，
 * 使用者每次重新整理都會先看到一閃而過的「權限不足」，那比慢半秒糟得多。
 */
const PermCtx = createContext({ allowed: null, can: () => true, reload: () => {} });

export function PermissionProvider({ children }) {
  const { isAuthed, role } = useAuth();
  const [allowed, setAllowed] = useState(null);

  async function load() {
    if (!isAuthed) { setAllowed(null); return; }
    try {
      const d = await rolePermissionsApi.mine();
      setAllowed(Array.isArray(d?.allowed) ? d.allowed : []);
    } catch {
      // 讀不到就退回 null＝「還不知道」，讓 can() 放行。
      // 這裡不 fail-closed 是刻意的：真正的把關在後端，前端擋不住的東西
      // 後端會擋；反過來把暫時讀不到當成沒權限，只會讓人以為系統壞了。
      setAllowed(null);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [isAuthed, role]);

  const can = (key) => {
    if (allowed === null) return true;     // 還沒載到
    if (role === 'admin') return true;     // 管理員永遠全開
    return allowed.includes(key);
  };

  return <PermCtx.Provider value={{ allowed, can, reload: load }}>{children}</PermCtx.Provider>;
}

export function usePermissions() { return useContext(PermCtx); }

