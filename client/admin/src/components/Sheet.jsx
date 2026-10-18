import React, { useEffect, useRef } from 'react';

/**
 * 手機底部面板 / 桌機置中彈窗
 *
 * 原本在 375px 會發生什麼：後台每個彈窗都是 `items-center` 置中，面板浮在畫面正中央，
 * 「儲存 / 確認」這排主要動作落在螢幕垂直中線附近 —— 單手握 375 寬的手機時，拇指
 * 自然覆蓋的是螢幕下三分之一，中線以上要換手或把手機往下滑才按得到。救生員在池畔
 * 是濕手、站著、單手，這個距離就是每一次操作都要多一個動作。
 * 而且置中彈窗沒有任何「可以往下滑關掉」的暗示，關閉只能瞄準右上角那顆 ✕。
 *
 * 改成：md 以下貼齊底部、上緣圓角、寬度滿版，主要動作留在拇指區；md 以上完全維持
 * 原本的置中彈窗（`md:items-center` + `md:rounded-*` + `md:max-w-*`），桌機不動。
 *
 * 遷移狀態：既有彈窗正在陸續換過來，新的彈窗一律直接用這支元件。
 * （這裡原本寫著「不要遷移」，理由是 tests/mobile_modal_test.js 斷言
 *   `fixed inset-0` 的出現次數 >= 15，收斂進元件會讓那個數字掉到個位數而變紅。
 *   那條判準已經改成數「原生 modal + <Sheet> 使用處」的總和，不再懲罰重構。
 *   一條會因為你把事情做對了而變紅的測試，等於是在付錢請大家不要整理程式碼。）
 * 還沒換過來的彈窗由 tests/mobile_sheet_test.js 逐檔盯住就地寫法是否正確。
 *
 * 安全區：貼底之後面板下緣會壓在 iPhone 的 home indicator 底下（812 的 SE 沒有，
 * 但 844/852 那批有 34px）。`pb-[env(safe-area-inset-bottom)]` 在桌機與無 indicator
 * 的裝置上求值為 0，等同沒有這行，所以不影響桌機。
 */
export default function Sheet({
  z = 'z-40',
  maxWidth = 'md:max-w-md',
  desktopRounded = 'md:rounded-2xl',
  label,
  onClose,
  closeOnBackdrop = true,
  header = null,
  footer = null,
  children,
}) {
  // Escape 關閉 + 鎖背景捲動：面板打開時背景不該還能捲。
  // onClose 走 ref 而不是進依賴陣列：呼叫端幾乎都是 inline 箭頭函式，每次 render 都是
  // 新身分；放進依賴陣列的話面板裡打一個字就會重跑 effect、把 body.overflow 拆掉再裝回去
  // （ConfirmDialog.jsx:11 記錄過同一個坑造成輸入框失焦）。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current?.(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <div
      className={`fixed inset-0 ${z} flex items-end justify-center bg-black/40 md:items-center md:px-4`}
      onClick={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose?.(); }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div className={`flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl pb-[env(safe-area-inset-bottom)] md:max-h-[90dvh] ${maxWidth} ${desktopRounded}`}>
        {/* grabber：行動裝置上「這個可以往下拉」的通用暗示。桌機沒有這個手勢，md 以上隱藏。 */}
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-gray-300 md:hidden" aria-hidden="true" />
        {header && <div className="shrink-0">{header}</div>}
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0">{footer}</div>}
      </div>
    </div>
  );
}
