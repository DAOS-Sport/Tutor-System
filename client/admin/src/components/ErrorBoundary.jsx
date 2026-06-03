import React from 'react';

/**
 * 全域錯誤邊界：避免任一頁面 render 拋錯就讓整個 React 樹卸載（= 整頁全白、
 * 使用者完全看不到任何訊息）。攔到錯誤時顯示可重新載入的 fallback，並把錯誤
 * 印到 console（componentStack 方便定位）。
 *
 * 用 inline style 不依賴 Tailwind / 外部 CSS，確保連 CSS 沒載到也能顯示。
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] 頁面 render 發生錯誤：', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
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
        <p style={{ fontSize: '13px', color: '#666', marginTop: '8px', maxWidth: '360px', lineHeight: 1.6 }}>
          載入時出了點問題。請點下方重新載入；若持續發生，請截圖此畫面回報。
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: '20px', background: '#15316a', color: '#fff', border: 'none',
            borderRadius: '8px', padding: '12px 28px', fontSize: '15px', fontWeight: 700, cursor: 'pointer',
          }}
        >
          重新載入
        </button>
        {this.state.error?.message && (
          <pre style={{
            marginTop: '16px', fontSize: '11px', color: '#999', whiteSpace: 'pre-wrap',
            maxWidth: '90vw', overflow: 'auto',
          }}>
            {String(this.state.error.message)}
          </pre>
        )}
      </div>
    );
  }
}
