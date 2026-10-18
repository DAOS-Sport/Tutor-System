import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../context/PermissionContext';

export default function RequireAuth({ children, roles }) {
  const { isAuthed, role } = useAuth();
  const { allowed, can } = usePermissions();
  const loc = useLocation();
  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  // F-A06：以角色權限設定為準。roles 陣列退居「權限還沒載到」時的後備 ——
  // 這樣重新整理時不會先閃一下「沒有權限」，載到之後才依實際設定判定。
  //
  // 這裡擋不住的東西後端仍會擋（第 4 期會把 83 處 requireAdminRole 也接上同一份設定）。
  // 在那之前，這一層只是選單以外的第二道提示，不是真正的把關。
  const key = loc.pathname.replace(/^\//, '').split('/')[0];
  const denied = allowed === null
    ? (roles && roles.length > 0 && !roles.includes(role))
    : !can(key);
  if (denied) {
    return (
      <div className="p-8 text-center">
        <div className="mb-2 text-base font-bold text-brand-error">沒有權限存取此頁面</div>
        <div className="text-sm text-gray-500">請聯絡系統管理員調整角色權限</div>
      </div>
    );
  }
  return children;
}
