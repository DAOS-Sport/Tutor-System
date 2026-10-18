/**
 * F-A06 第 4 期：後端閘門改讀角色權限設定。
 *
 * 在此之前，權限是三份各自獨立的東西：側邊選單的 roles 陣列、路由守衛的 roles
 * 陣列、以及這裡的 requireAdminRole(...)。前兩份第 3 期已經接上設定，但只要
 * 這一份還是寫死的，管理員在 F-A06 取消勾選只會讓「選單看不到」——
 * 用開發者工具直接打 API 照樣拿得到資料。那是最糟的一種狀態：畫面讓人
 * 以為權限關掉了，實際上沒有。
 *
 * ── 為什麼不是「舊閘門 AND 新設定」──
 * 那樣只能收緊、不能放寬：管理員把某頁勾給救生員，舊閘門仍會擋下來。
 * 使用者要的是完整控制，所以設定表就是唯一權威，舊的 roles 陣列整個退場。
 *
 * ── 共用查詢為什麼另外開一個 requireAnyBackoffice ──
 * 場館清單、教練清單、課期清單這類端點不屬於任何一個頁面 —— 幾乎每個頁面
 * 都要拿它們來填下拉。把它們綁在「場館設定」這種 admin 專屬資源上，
 * 會讓所有非管理員的頁面在載入下拉時就壞掉。它們不是權限邊界，是基礎資料。
 */
'use strict';

const { canUserAccess } = require('../services/rolePermissions');
const { isResourceKey } = require('../constants/adminResources');

function deny(res) {
  return res.status(403).json({
    error: '沒有權限存取此功能，請聯絡系統管理員調整角色權限',
    code: 'RESOURCE_FORBIDDEN',
  });
}

/**
 * 綁定到某一個後台頁面的權限。
 * @param {string} resourceKey adminResources 裡的 key
 */
function requireResource(resourceKey) {
  // 啟動時就炸，不要等到有人打進來才發現 key 打錯 ——
  // 打錯的 key 在 canAccess 裡會一律拒絕，症狀是「這頁對所有人都壞了」，
  // 而錯誤訊息只會說沒有權限，沒有人查得到真正的原因。
  if (!isResourceKey(resourceKey)) {
    throw new Error(`requireResource: 未知的資源代號「${resourceKey}」`);
  }
  return async (req, res, next) => {
    const role = req.adminUser?.role;
    if (!role) return res.status(401).json({ error: 'Unauthenticated' });
    // 帶上 sub（admin_users.id）才套得到個人例外；只給角色的話，
    // 在 F-A06 為某個人單獨開通或收回的設定會完全沒有作用。
    const who = { role, userId: req.adminUser.sub };
    try {
      if (await canUserAccess(who, resourceKey)) return next();
      return deny(res);
    } catch (err) {
      // 讀不到設定時一律拒絕。放行會在資料庫抖一下的時候把整個後台敞開，
      // 而那正是最不該放行的時刻。
      console.error('[requireResource] 權限查詢失敗，一律拒絕：', err.message);
      return deny(res);
    }
  };
}

/**
 * 共用基礎資料：任何能登入後台的角色都可以讀。
 * 用在「不屬於任何頁面、但每個頁面都要」的查詢端點。
 */
function requireAnyBackoffice() {
  return (req, res, next) => {
    if (!req.adminUser?.role) return res.status(401).json({ error: 'Unauthenticated' });
    return next();
  };
}

/**
 * 多個頁面共用的端點：只要其中任何一個頁面用得到，就放行。
 *
 * 例：報名清單同時被「所有報名」「退課處理」「待對帳」三頁使用。
 * 綁死在其中一個資源上，另外兩頁會在管理員取消勾選那一個時莫名壞掉 ——
 * 而症狀是「退課頁打不開」，沒有人會聯想到是「所有報名」被關掉。
 */
function requireAnyResource(...resourceKeys) {
  for (const k of resourceKeys) {
    if (!isResourceKey(k)) throw new Error(`requireAnyResource: 未知的資源代號「${k}」`);
  }
  return async (req, res, next) => {
    const role = req.adminUser?.role;
    if (!role) return res.status(401).json({ error: 'Unauthenticated' });
    const who = { role, userId: req.adminUser.sub };
    try {
      for (const k of resourceKeys) {
        if (await canUserAccess(who, k)) return next();
      }
      return deny(res);
    } catch (err) {
      console.error('[requireAnyResource] 權限查詢失敗，一律拒絕：', err.message);
      return deny(res);
    }
  };
}

module.exports = { requireResource, requireAnyResource, requireAnyBackoffice };

