import React from 'react';

/**
 * 頁面標題列。34 個頁面在用，其中 14 個會傳 actions。
 *
 * 為什麼副標要獨立一行：原本的結構是
 *   [ 標題 / 副標 ]  ...  [ actions ]
 * 左半邊是一個 flex item，它的寬度由「標題與副標之中較寬的那個」決定 ——
 * 而副標幾乎一定比標題長。上課紀錄查詢實測：標題 108px、副標 196px，
 * 左半邊因此是 197px，加上三顆控制項 206px 共 403px，超過 375px 螢幕的
 * 343px 可用寬，actions 必定被擠到下一行，白白多吃掉一整列（58px）。
 *
 * 把副標移到整排底下之後，標題只佔它自己的 108px：
 *   108 + gap 12 + actions 206 = 326px ≤ 343px，三顆控制項留在標題同一排。
 *
 * 仍然保留 flex-wrap：標題長的頁面（例如「(Z02) 學員資料（含購買紀錄）」）
 * 放不下時還是會自己換行，不會被截斷。actions 加 shrink-0，
 * 是因為它們是固定寬度的控制項，被壓縮只會讓裡面的中文折行。
 *
 * 桌機的視覺位置沒有變（副標本來就在標題底下），只是行距收緊了一點。
 */
export default function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-4 border-b border-gray-200 pb-3 md:mb-6 md:pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold text-brand-primary md:text-xl">{title}</h1>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
      {subtitle && <p className="mt-1 text-xs text-gray-500 md:text-sm">{subtitle}</p>}
    </div>
  );
}
