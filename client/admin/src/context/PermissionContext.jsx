import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
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
const PermCtx = createContext({ allowed: null, actions: null, can: () => true, reload: () => {} });

// 讀不到時的重試間隔。只失敗一次就停在「還不知道」的話，畫面會一直用後備
// roles 陣列，直到使用者自己重新整理才拿到真正的設定。
export const PERMISSION_RETRY_MS = [2000, 5000, 15000];

export function PermissionProvider({ children }) {
  const { isAuthed, role } = useAuth();
  const [allowed, setAllowed] = useState(null);
  // 動作層級權限（C 期），例如「刪除 Z03 紀錄」。代號長得像「頁面:動作」。
  const [actions, setActions] = useState(null);
  const retryTimer = useRef(null);
  const generation = useRef(0);

  async function load(attempt = 0) {
    clearTimeout(retryTimer.current);
    const gen = ++generation.current;
    if (!isAuthed) { setAllowed(null); setActions(null); return; }
    try {
      const d = await rolePermissionsApi.mine();
      if (gen !== generation.current) return;
      setAllowed(Array.isArray(d?.allowed) ? d.allowed : []);
      setActions(Array.isArray(d?.actions) ? d.actions : []);
    } catch {
      if (gen !== generation.current) return;
      // 讀不到就退回 null＝「還不知道」，讓 can() 放行。
      // 這裡不 fail-closed 是刻意的：真正的把關在後端，前端擋不住的東西
      // 後端會擋；反過來把暫時讀不到當成沒權限，只會讓人以為系統壞了。
      setAllowed(null);
      setActions(null);
      if (attempt < PERMISSION_RETRY_MS.length) {
        retryTimer.current = setTimeout(() => load(attempt + 1), PERMISSION_RETRY_MS[attempt]);
      }
    }
  }

  useEffect(() => {
    load();
    return () => { clearTimeout(retryTimer.current); generation.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed, role]);

  const can = (key) => {
    if (allowed === null) return true;     // 還沒載到
    if (role === 'admin') return true;     // 管理員永遠全開
    return allowed.includes(key);
  };

  // 動作按鈕要不要畫出來。跟 can() 不同：還沒載到時回 false ——
  // 按鈕晚半秒出現無傷大雅，先畫出來、點下去才吃 403 才讓人困惑。
  // 真正的把關一樣在後端（requireAction）。
  const canDo = (key) => {
    if (role === 'admin') return true;
    return Array.isArray(actions) && actions.includes(key);
  };

  return <PermCtx.Provider value={{ allowed, actions, can, canDo, reload: () => load() }}>{children}</PermCtx.Provider>;
}

export function usePermissions() { return useContext(PermCtx); }

