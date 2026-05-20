import React, { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';

/**
 * Task #91：F-C-Admin 教練資料已合併進「員工帳號管理 (F-A02)」。
 * 訪問舊路徑 /coaches → 自動導去 /staff 並提示 toast，
 * 避免直接 404 讓使用者誤以為是 bug，也覆蓋舊瀏覽器書籤 / 連結。
 */
export default function CoachesRedirect() {
  const toast = useToast();
  useEffect(() => {
    toast.info('教練資料已合併到「員工帳號管理」，請在員工編輯彈窗中設定教練欄位');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Navigate to="/staff?role=coach" replace />;
}
