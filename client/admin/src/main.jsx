import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
// 與家長端共用同一份：兩邊各留一份的結果是文案一字不差，
// 收到截圖時連「這是哪一支前端」都分不出來。
import ErrorBoundary from '../../shared/ErrorBoundary.jsx';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
// 必須在 AuthProvider 內側：它要先知道有沒有登入、是什麼角色。
import { PermissionProvider } from './context/PermissionContext';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary app="後台">
      <BrowserRouter basename="/admin">
        <AuthProvider>
          <ToastProvider>
            <PermissionProvider>
            <App />
            </PermissionProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
