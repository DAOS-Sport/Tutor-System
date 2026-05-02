import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function RequireAuth({ children, roles }) {
  const { isAuthed, role } = useAuth();
  const loc = useLocation();
  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  if (roles && roles.length > 0 && !roles.includes(role)) {
    return (
      <div className="p-8 text-center">
        <div className="mb-2 text-base font-bold text-brand-error">沒有權限存取此頁面</div>
        <div className="text-sm text-gray-500">請聯絡系統管理員調整角色權限</div>
      </div>
    );
  }
  return children;
}
