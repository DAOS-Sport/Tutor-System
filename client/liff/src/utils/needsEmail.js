/**
 * 家長是否該被提醒補 Email。
 *
 * 抽成純函式的理由：這個判斷的失效方向不對稱。
 * 少提醒一位 → 那家人維持現狀，櫃檯照舊打電話；
 * 多提醒一位 → 五百多個資料完整的家庭每次開 App 都看到一則假警報。
 * 所以規則是「證據不足就不提醒」，而不是「不確定就先跳出來」。
 *
 * 具體來說：物件裡根本沒有 email 這個 key 時回 false。
 * 那代表拿到的形狀不是我們認識的家長物件（例如舊版寫進 localStorage 的快取），
 * 而不是「這位家長沒填 Email」—— 後端 _issue() 一律帶 email（缺就是 null）。
 */
export function needsEmailPrompt(parent) {
  if (!parent || typeof parent !== 'object') return false;
  if (!('email' in parent)) return false;
  return String(parent.email || '').trim() === '';
}

export default needsEmailPrompt;

