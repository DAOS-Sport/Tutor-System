import { useEffect, useState } from 'react';

// Task #88：偵測 server 端是否有新版 SPA bundle。
// 機制：開頁時記下目前 <script src="/admin/assets/index-XXX.js"> 的 hash，
// 每 5 分鐘 + 每次 tab 重新 focus 時，no-store fetch `/admin/index.html` 比對。
// 不同 → 回傳 true，由 UI 顯示「點此重整」提示條（不強制 reload，使用者
// 可能正在填表單）。

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const BUNDLE_RE = /\/admin\/assets\/(index-[A-Za-z0-9_-]+\.js)/;

function readCurrentBundle() {
  if (typeof document === 'undefined') return null;
  const scripts = document.querySelectorAll('script[src*="/admin/assets/index-"]');
  for (const s of scripts) {
    const m = (s.getAttribute('src') || '').match(BUNDLE_RE);
    if (m) return m[1];
  }
  return null;
}

async function fetchLatestBundle() {
  try {
    const res = await fetch('/admin/index.html', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(BUNDLE_RE);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function useSpaVersionCheck() {
  const [outdated, setOutdated] = useState(false);
  const [latest, setLatest] = useState(null);

  useEffect(() => {
    const current = readCurrentBundle();
    if (!current) return undefined; // dev 模式 (vite) 沒有 hash script，跳過

    let cancelled = false;
    let timer = null;

    async function check() {
      const remote = await fetchLatestBundle();
      if (cancelled) return;
      if (remote && remote !== current) {
        setLatest(remote);
        setOutdated(true);
      }
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => { await check(); schedule(); }, POLL_INTERVAL_MS);
    }

    function onWake() {
      if (!outdated) check();
    }
    function onVisible() {
      if (!outdated && document.visibilityState === 'visible') check();
    }

    // 初次延遲 30s 再打第一次，避開頁面初始 burst
    timer = setTimeout(async () => { await check(); schedule(); }, 30 * 1000);
    // focus 在部分瀏覽器/視窗狀態下 tab 切回不會 fire，補上 visibilitychange 以涵蓋背景 tab 場景
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [outdated]);

  return { outdated, latest, reload: () => window.location.reload() };
}
