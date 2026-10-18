import React from 'react';
import PageHeader from '../components/PageHeader';

/**
 * 櫃台手冊
 *
 * 內容是一份獨立的靜態頁，放在 server/public/brand/manual/。
 * 用 iframe 崁進來而不是搬成 React 元件，理由有三個：
 *
 *  1. 那份頁面自帶吸頂目錄、即時搜尋與一整套自己的樣式（CSS 變數、字級、
 *     色票都跟後台的 Tailwind 不同套）。搬進來兩邊會互相蓋。
 *  2. 手冊會常改 —— 換截圖、流程調整。改一個 HTML 就好，不用重新 build 前端。
 *  3. 同一份檔案也能直接給網址，讓人在後台外面看（教練、新人、外部參考）。
 *
 * 手冊本身不含任何客戶資料：所有截圖都是在測試環境用測試帳號拍的。
 */
const MANUAL_URL = '/brand/manual/';

export default function CounterManualPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="櫃台手冊"
        subtitle="家長站在你面前時，你要按哪裡。含建訂單、對帳、退課、補簽到、扣課復活與查詢，每一步都有標紅框的實機截圖。"
        actions={(
          <a
            href={MANUAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center rounded-md bg-brand-primary px-4 text-sm font-bold text-white hover:opacity-90 md:min-h-0 md:py-2"
          >
            另開視窗看
          </a>
        )}
      />

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <iframe
          src={MANUAL_URL}
          title="櫃台手冊"
          loading="lazy"
          className="block w-full border-0"
          style={{ height: 'calc(100vh - 210px)', minHeight: 520 }}
        />
      </div>

      <p className="text-xs text-gray-400">
        手冊內容獨立於後台，改版時只需要更新 <span className="font-mono">server/public/brand/manual/</span>。
      </p>
    </div>
  );
}
