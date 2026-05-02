import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import liff from '@line/liff';
import App from './App';
import './index.css';

async function initLiff() {
  await liff.init({ liffId: import.meta.env.VITE_LIFF_ID });
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: window.location.href });
    return;
  }
  ReactDOM.createRoot(document.getElementById('root')).render(
    <BrowserRouter basename="/liff">
      <App />
    </BrowserRouter>
  );
}

initLiff().catch(console.error);
