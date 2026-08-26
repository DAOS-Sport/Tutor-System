import React from 'react';

/**
 * 分批清單的頁尾：載入中轉圈 / 到底了 / 這一批失敗可重試。
 *
 * 三種狀態都要看得見，尤其是「到底了」——沒有這個標示的話，使用者永遠不確定
 * 「是真的沒有了，還是還沒載完」，只好一直往下捲。這正是分批載入最容易忽略的一半。
 *
 * 失敗時刻意只擋住這一批（顯示重試），不把整頁清空：已經看到的資料還是有用的。
 */
export default function ListFooter({ loading, done, error, count, onRetry, onLoadMore, sentinelRef, unit = '筆' }) {
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <div className="text-xs text-red-600">這一批載入失敗：{error}</div>
        <div className="text-[11px] text-gray-400">已載入的 {count} {unit}仍然可用</div>
        {onRetry && (
          <button type="button" onClick={onRetry}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-bold text-gray-600 hover:bg-gray-50">
            重試這一批
          </button>
        )}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-xs text-gray-400">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-brand-primary" />
        載入中…（已載入 {count} {unit}）
      </div>
    );
  }
  if (done) {
    return (
      <div className="py-6 text-center text-xs text-gray-400">
        {count === 0 ? '沒有資料' : `已經到底了 · 共 ${count} ${unit}`}
      </div>
    );
  }
  // 還沒到底、也不在載入中：放哨兵，捲到這裡就自動載下一批。
  //
  // 哨兵同時是一顆可點的按鈕，不是純文字。IntersectionObserver 正常時使用者
  // 根本不會看到它（rootMargin 提前 300px 觸發）；但只要 IO 因為任何原因沒作用
  // ——舊瀏覽器、內嵌 WebView、或像我們測試用的模擬視窗那樣整個失效——
  // 純文字的哨兵會讓人永遠卡在第一批，而且畫面上完全看不出哪裡不對：
  // 它看起來就只是「資料只有這麼多」。有一顆按鈕，最差也只是多點一下。
  return (
    <div ref={sentinelRef} className="py-4 text-center">
      <button
        type="button"
        onClick={onLoadMore || onRetry}
        className="min-h-[44px] rounded-lg border border-gray-300 px-4 py-2 text-xs text-gray-500 hover:bg-gray-50 md:min-h-0"
      >
        載入更多（已載入 {count} {unit}）
      </button>
    </div>
  );
}
