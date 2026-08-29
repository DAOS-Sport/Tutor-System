/**
 * 「這個事件算不算點到面板外面？」
 *
 * 抽出來是為了測得到 —— 這段邏輯壞掉的樣子是「面板自己消失」，
 * 在畫面上看起來像當機，但不會留下任何錯誤紀錄。
 *
 * ── 為什麼不能只用 contains() ──
 * 家長回報「註冊填生日、填完月份就跳掉」，桌機 Chrome 與 375px 手機模擬
 * 都重現不出來。差別在原生 <select>（選年份那個）：
 * 桌機開的是行內下拉，LINE 的內建瀏覽器（Android WebView / iOS WKWebView）
 * 開的是**系統對話框**。對話框關閉時 WebView 會補送滑鼠事件，
 * 而那顆事件的 target 往往是 document / body，或是一個已經從 DOM 移除的節點。
 * 原本的寫法只問「target 在不在面板裡」，這種事件一律被判成「點到外面」
 * 而把面板關掉 —— 使用者什麼都還沒做完，畫面就跳掉了。
 *
 * ── 為什麼不能用 activeElement 當護欄 ──
 * 直覺會想寫「焦點還在面板內就不關」，但觸發鈕本身也在 box 裡，
 * 開啟後焦點就停在它身上，那樣會變成永遠關不掉。
 *
 * 取捨：點在頁面空白處（target 是 body）現在不會關閉面板。
 * 使用者仍可按 Esc、再點一次觸發鈕、或直接選日期。
 * 用「偶爾要多點一下」換「填到一半整個跳掉」，這個方向是對的。
 */
export function shouldCloseOnOutsidePointer(box, target) {
  if (!box) return false;

  // 已經不在 DOM 上的節點：多半是剛被 React 卸載掉的東西，
  // 或 WebView 在對話框關閉後補送的事件。不能當成使用者的操作。
  if (!target || typeof target !== 'object') return false;
  if (typeof target.isConnected === 'boolean' && !target.isConnected) return false;

  // document / <html> / <body> 這種頂層節點不是「某個面板外的東西」，
  // 而是事件沒有真正的目標。系統對話框關閉時補送的事件就長這樣。
  const doc = box.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (doc && (target === doc || target === doc.body || target === doc.documentElement)) return false;

  if (typeof box.contains === 'function' && box.contains(target)) return false;
  return true;
}

export default shouldCloseOnOutsidePointer;

