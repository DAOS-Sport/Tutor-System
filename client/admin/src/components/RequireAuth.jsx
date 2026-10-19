import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../context/PermissionContext';

export default function RequireAuth({ children, roles, action }) {
  const { isAuthed, role } = useAuth();
  const { allowed, can, canDo } = usePermissions();
  const loc = useLocation();
  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  // F-A06：以角色權限設定為準。roles 陣列退居「權限還沒載到」時的後備 ——
  // 這樣重新整理時不會先閃一下「沒有權限」，載到之後才依實際設定判定。
  // 真正的把關在後端 requireResource（同一份設定）；這一層只決定畫面要不要顯示。
  const key = loc.pathname.replace(/^\//, '').split('/')[0];
  // action：不在側邊選單上、靠單一動作權限進入的頁面（例如 Ragic 待審核區，C 期）。
  const denied = allowed === null
    ? (roles && roles.length > 0 && !roles.includes(role))
    : (action ? !canDo(action) : !can(key));
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
