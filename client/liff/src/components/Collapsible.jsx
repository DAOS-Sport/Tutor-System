import React from 'react';

/**
 * 橫條式折疊：點標題列展開／收合內容。
 *
 * 原本住在 ProfilePage.jsx（家長端個人頁）裡，教練端個人頁也要同一個外觀，
 * 所以抽出來共用。複製第二份的話兩邊遲早會長得不一樣 —— 這種「看起來只是樣式」
 * 的重複最容易漂移，因為沒有人會為了改個 padding 去看另一個檔案。
 *
 * props
 *   accent    最外層用：左側主色條、字較大
 *   nested    子層用：較精簡的內距與字級
 *   subtitle  標題右側的灰色小字（例如「共 3 位」）
 *   action    標題列最右側的自訂元素（例如「編輯 ✏」／「儲存」）
 *
 * ⚠️ action 是獨立於切換鈕之外的一個元素，不是包在裡面。
 *    切換鈕本身是 <button>，把另一顆 button 塞進去是不合法的 HTML，
 *    而且點「儲存」會連帶觸發收合 —— 使用者會以為存檔失敗。
 */
export default function Collapsible({ title, subtitle, open, onToggle, accent, nested, action, children }) {
  return (
    <div className={`overflow-hidden rounded-xl border bg-white ${open ? 'border-brand-primary/30' : 'border-gray-200'}`}>
      <div className={`flex items-center gap-1 pr-3 ${nested ? 'py-0.5' : ''}`}>
        <button
          type="button"
          onClick={onToggle}
          className={`flex min-w-0 flex-1 items-center justify-between gap-2 pl-4 text-left active:bg-gray-50 ${nested ? 'py-2.5' : 'py-3.5'} ${action ? 'pr-2' : 'pr-3'}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {accent && <span className="h-4 w-1 shrink-0 rounded-full bg-brand-primary" />}
            <span className={`truncate font-bold text-brand-primary ${nested ? 'text-sm' : 'text-base'}`}>{title}</span>
            {subtitle && <span className="shrink-0 text-xs font-normal text-gray-400">{subtitle}</span>}
          </span>
          <ChevronIcon className={`shrink-0 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
        </button>
        {action}
      </div>
      {open && <div className="border-t border-gray-100 px-3 py-3">{children}</div>}
    </div>
  );
}

export function ChevronIcon({ className = '' }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
