import React from 'react';

/**
 * 全域錯誤邊界（後台與家長端共用）
 *
 * 避免任一頁面 render 拋錯就讓整個 React 樹卸載（＝整頁全白，使用者看不到任何訊息）。
 *
 * ── 為什麼要自報身分 ──
 * 這支原本只印一行 error.message。2026-08-27 收到一張這個畫面的截圖，
 * 上面只有「Cannot read properties of undefined (reading 'map')」，
 * 而錯誤邊界掛在 main.jsx 最外層，所以側邊欄也一起消失 —— 截圖裡沒有任何
 * 線索指出是哪一頁。當時把後台 34 條路由在桌機、375px、以及「API 全部失敗」
 * 三種狀態下各掃一遍，又逐頁點開詳情彈窗，全部正常，最後仍然定位不到。
 *
 * 更糟的是後台與家長端各有一份 ErrorBoundary，文案一字不差，
 * 連「這是哪一支前端」都分不出來。
 *
 * 所以：畫面上直接寫出「哪一支前端 · 哪一個路徑 · 什麼時間」。
 * 一張截圖就要能定位，不需要再回頭問人。
 *
 * ── 元件名稱為什麼只放在複製區、不放在畫面上 ──
 * 正式 build 經過 minify，React 的 componentStack 讀的是函式名稱，
 * 會變成 `at a`、`at t` 這種單字母。放在畫面上只會佔位置又誤導；
 * 但它對照 source map 仍有用，所以收進「複製診斷資訊」裡。
 *
 * 用 inline style 不依賴 Tailwind／外部 CSS：CSS 沒載到的時候這支還是要能顯示，
 * 而「CSS 沒載到」本來就是會走到這裡的原因之一。
 */

function where() {
  try {
    return (window.location.pathname || '') + (window.location.search || '');
  } catch {
    return '(unknown)';
  }
}

function stamp() {
  try {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
      + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return '';
  }
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stack: '', copied: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const stack = (info && info.componentStack) || '';
    this.setState({ stack });
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.app || '?', where(), error, stack);
  }

  /** 一段可以直接貼給工程師的純文字。畫面上看得到的東西，加上元件堆疊。 */
  report() {
    const { error, stack } = this.state;
    return [
      `[${this.props.app || '?'}] ${where()}`,
      `時間：${stamp()}`,
      `錯誤：${(error && (error.message || String(error))) || '(no message)'}`,
      `UA：${(typeof navigator !== 'undefined' && navigator.userAgent) || ''}`,
      stack ? `元件堆疊：${stack}` : '',
    ].filter(Boolean).join('\n');
  }

  copy = () => {
    const text = this.report();
    const ok = () => this.setState({ copied: true });
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, () => this.fallbackCopy(text, ok));
        return;
      }
    } catch { /* 落到下面的 fallback */ }
    this.fallbackCopy(text, ok);
  };

  /** clipboard API 在非安全來源與部分 WebView（含 LINE 內建瀏覽器）不可用。 */
  fallbackCopy(text, ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      ok();
    } catch {
      // 複製失敗不需要再提示：這段文字本來就印在畫面上，截圖一樣拿得到。
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { copied } = this.state;
    const btn = {
      borderRadius: '8px', padding: '12px 24px', fontSize: '15px',
      fontWeight: 700, cursor: 'pointer', border: 'none',
    };
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: '24px',
        textAlign: 'center', fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{ fontSize: '44px' }}>😵</div>
        <h1 style={{ fontSize: '18px', fontWeight: 700, marginTop: '12px', color: '#15316a' }}>
          頁面發生錯誤
        </h1>
        <p style={{ fontSize: '13px', color: '#666', marginTop: '8px', maxWidth: '340px', lineHeight: 1.6 }}>
          載入時出了點問題。請點下方重新載入；若持續發生，請複製回報資訊交給管理員。
        </p>

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button type="button" onClick={() => window.location.reload()}
            style={{ ...btn, background: '#15316a', color: '#fff' }}>
            重新載入
          </button>
          <button type="button" onClick={this.copy}
            style={{ ...btn, background: '#eef1f6', color: '#15316a' }}>
            {copied ? '已複製 ✓' : '複製診斷資訊'}
          </button>
        </div>

        {/* 這一塊就是「讓一張截圖足以定位」的全部理由。順序照排查時的實際用法：
            先看是哪一支前端的哪一頁，再看錯誤本身。 */}
        <div style={{
          marginTop: '20px', maxWidth: '92vw', textAlign: 'left',
          background: '#f7f8fa', border: '1px solid #e3e6ec', borderRadius: '10px',
          padding: '12px 14px', fontSize: '12px', lineHeight: 1.7, color: '#5b6472',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          overflowX: 'auto',
        }}>
          <div style={{ color: '#15316a', fontWeight: 700 }}>
            {this.props.app || '?'} · {where()}
          </div>
          <div>{stamp()}</div>
          <div style={{ marginTop: '6px', color: '#8a4b4b', whiteSpace: 'pre-wrap' }}>
            畫面暫時無法顯示。請重新載入；若仍無法使用，請將回報資訊交給管理員。
          </div>
        </div>
      </div>
    );
  }
}
