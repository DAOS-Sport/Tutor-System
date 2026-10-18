/**
 * 誰可以發出、收回「系統管理員」這個身分。
 *
 * 抽成獨立模組不是為了重用，是為了測得動：這是一條安全規則，
 * 而它原本埋在 routes/admin/staff.js 裡 —— 那個檔案 require 進來會一起拉起
 * Ragic 同步服務與 LINE 服務，測試只好改成讀原始碼比對字串。
 * 結果就是「把守衛的第一行改成 return null」測試照樣全綠（實測過）。
 * 純邏輯放在純模組裡，才驗得到行為而不只是長相。
 *
 * ── 規則本身 ──
 * F-A02（員工帳號管理）能指派角色，而可指派清單含 'admin'，角色驗證只檢查
 * 「在不在清單裡」。所以只要管理員在 F-A06 把「員工帳號管理」勾給場館主管，
 * 那位主管就能 PATCH 自己 { roles: ['admin'] } → admin_staff_roles 多一列
 * admin → 身分聯集含 admin → canUserAccess 直接 return true → 34 頁全開，
 * 而且不必重新登入（權限快取 15 秒）。另外兩個出口是 POST 新建一個 admin
 * 帳號（預設密碼＝電話），以及 reset-password 重設現任 admin 的密碼。
 *
 * ── 為什麼不是把整支路由鎖成 admin ──
 * 那會讓「把員工帳號管理委派給場館主管」變成不可能，而那正是 F-A06 的意義。
 * 要擋的是「發出 admin 這個特定角色」，不是「進入這支路由」。
 *
 * ── 依據哪一個身分判斷呼叫者 ──
 * token 上的 role。與 routes/admin/rolePermissions.js 的寫入端一致
 * （那邊用 requireAdminRole('admin')）—— 「能授予權限」這件事在整個系統裡
 * 只認同一個依據，否則又是一組會漂移的判定。
 */
function adminGrantBlocked(req, wantedRoles) {
  const wanted = (wantedRoles || []).filter(Boolean).map(String);
  if (!wanted.includes('admin')) return null;
  if (req && req.adminUser && req.adminUser.role === 'admin') return null;
  return {
    error: '只有系統管理員能指派或變更系統管理員身分',
    code: 'ADMIN_GRANT_FORBIDDEN',
  };
}

module.exports = { adminGrantBlocked };
