'use strict';
/**
 * 課程需求管理頁的定價區 UI（F-A08 階段 4b）迴歸鎖。
 *
 * 這一頁是「哪個場館收多少錢」的唯一設定入口，所以鎖兩件事：
 *
 *   1. 每一支 API 呼叫都帶定價區。少一個就會讀到／寫到別頁的價，
 *      而畫面上完全看不出來 —— 後端雖然會回 400 ZONE_REQUIRED 擋住，
 *      但那是最後一道防線，不該讓它常態被觸發。
 *   2. 場館勾選的文案講的是「搬過來」而不是「建議避免重複」。
 *      舊版 mockup 寫的是「同一場館出現在多頁時以最新發布的價格為準」——
 *      那是一條看不見的規則，改 A 頁會改變 B 頁場館的收費結果。
 *      實作上一個場館只可能屬於一頁（venues.pricing_zone_id 單一外鍵），
 *      文案必須跟資料模型講同一件事。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'client/admin/src/pages/CourseTypesPage.jsx'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'client/admin/src/api/courseTypes.js'), 'utf8');
const ZONE_API = fs.readFileSync(path.join(ROOT, 'client/admin/src/api/pricingZones.js'), 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

check('API client 每一支都收定價區', () => {
  for (const sig of [
    'list:   (zone)',
    'create: (zone, data)',
    'update: (zone, type, patch)',
    'remove: (zone, type)',
    'auditLogs: (zone, type)',
  ]) {
    assert.ok(API.includes(sig), `courseTypesApi 缺少帶區的簽名：${sig}`);
  }
});

check('頁面所有 courseTypesApi 呼叫都把區傳進去', () => {
  // coachMultipliers 是全公司共用的教練加成級距清單，不屬於任何一區。
  const calls = PAGE.match(/courseTypesApi\.(\w+)\(([^)]*)/g) || [];
  assert.ok(calls.length >= 6, '呼叫點應該至少有 6 處，實得 ' + calls.length);
  for (const c of calls) {
    if (c.includes('coachMultipliers')) continue;
    assert.ok(/\((zoneId|zid)\b/.test(c),
      `這個呼叫沒帶定價區：${c}`);
  }
});

check('沒決定定價區之前不送出查詢', () => {
  assert.ok(PAGE.includes('if (!zid) return;'),
    'zoneId 還沒決定就打 API，只會拿到 400；載入順序要先有區再載品項');
});

check('分頁列存在，且切頁會重載品項', () => {
  assert.ok(PAGE.includes('function switchZone'), '要有切換需求頁的行為');
  assert.ok(/switchZone[\s\S]{0,220}load\(z\.id\)/.test(PAGE), '切頁必須重載該區的品項');
});

check('一期堂數：新增時能填，既有的也能改', () => {
  // 三蘆 6 堂、松山 10 堂。少了這個欄位，松山的拆期會沿用 6 堂而算錯金額。
  assert.ok(PAGE.includes('sessions_per_period'), '新增需求頁必須能設定一期幾堂');
  assert.ok(PAGE.includes('zoneSessions'), '既有需求頁也要能改一期堂數，不能只有新增時可填');
  assert.ok(/pricingZonesApi\.update\(zoneId, \{ sessions_per_period/.test(PAGE),
    '儲存時要把一期堂數寫回去');
});

check('可買期數不做成設定項', () => {
  // 家長要買幾期由家長決定。這兩個欄位在後端也從來沒有被業務邏輯讀過，
  // 放在畫面上只會讓人以為它有作用。
  for (const dead of ['period_count_min', 'period_count_max']) {
    assert.ok(!PAGE.includes(dead), `${dead} 不該出現在需求頁設定 UI`);
  }
});

check('場館勾選的文案講「搬過來」，不是「建議避免重複」', () => {
  assert.ok(PAGE.includes('一個場館只會屬於一頁'), '必須明講互斥');
  assert.ok(/勾選已在其他頁的場館，等於把它搬過來/.test(PAGE), '要說清楚勾選的後果是搬移');
  for (const bad of ['最新發布', '建議避免', '重複勾選']) {
    assert.ok(!PAGE.includes(bad),
      `「${bad}」這種說法代表同一場館可以同時屬於多頁，與資料模型不符`);
  }
});

check('已被其他頁使用的場館標出歸屬', () => {
  assert.ok(PAGE.includes('在「{owner.name}」') || PAGE.includes('owner.name'),
    '勾選清單要顯示這個場館目前屬於哪一頁，不然使用者不知道自己在搬東西');
});

check('不出現「未分配場館」這種常態性警告', () => {
  // 26 個場館裡只有 3 個真的有家教課，其餘多半是勞務館。
  // 把「沒有定價區」當成待辦事項，等於天天喊狼來了。
  assert.ok(!PAGE.includes('未分配'),
    '多數場館本來就沒有家教品項，沒有定價區是正常狀態，不該做成提示');
  assert.ok(ZONE_API.includes('unassigned_with_courses'),
    '後端只回「有課在跑卻沒有定價區」的場館 —— 那才是真的會壞事的狀況');
});

if (failed) {
  console.error(`\ncourse_types_zone_ui_test: ${failed} FAILED`);
  process.exit(1);
}
console.log('course_types_zone_ui_test: PASS');
