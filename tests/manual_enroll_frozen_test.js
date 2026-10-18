'use strict';
/**
 * 迴歸鎖：櫃台「手動建檔」整條路線已凍結（2026-10-15 使用者凍結令，見根目錄 CLAUDE.md）。
 *
 * 凍結範圍：
 *   1. server/routes/admin/enrollments.js 中「// 🧊 BEGIN 手動建檔凍結區」與「// 🧊 END 手動建檔凍結區」
 *      之間的 POST /api/admin/enrollments 整支路由（含說明註解）。
 *   2. client/admin/src/pages/ManualEnrollPage.jsx 整個檔案。
 *
 * 這支測試比對兩處的內容指紋（換行統一成 \n 後的 sha256）。改到任何一個字元都會紅燈 ——
 * 那正是凍結的意思：改之前必須先向擁有者列出要改什麼、為什麼，取得明確同意。
 * 同意並改完之後，才可在同一次變更中更新下面的指紋，並在這裡追加一行同意紀錄：
 *
 * 同意紀錄：
 *   2026-10-15 建立凍結（指紋取自正式站 build a91490e ＋ 本次只加入的兩行凍結標記）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EXPECTED_ROUTE = '3b59adad7aa32bedd61323be260cc9905a7a6ec72f4be5ae275bb3e2821bbbf6';
const EXPECTED_PAGE = '7edbd5179b0f5973c926ebfe204b30bcbfe474aec7e3d44a0e237f2e4956fab8';
const HOW_TO = '手動建檔是凍結區（CLAUDE.md「手動建檔凍結令」）：改之前必須先取得擁有者明確同意；同意後才在同一次變更更新本測試的指紋與同意紀錄。';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ok ' + name);
}

const lines = read('server/routes/admin/enrollments.js').split('\n');
const begins = lines.map((l, i) => (l.startsWith('// 🧊 BEGIN 手動建檔凍結區') ? i : -1)).filter((i) => i >= 0);
const ends = lines.map((l, i) => (l.startsWith('// 🧊 END 手動建檔凍結區') ? i : -1)).filter((i) => i >= 0);

check('凍結標記各只有一組，且順序正確', () => {
  assert.strictEqual(begins.length, 1, `BEGIN 標記應該剛好 1 個，實際 ${begins.length}。${HOW_TO}`);
  assert.strictEqual(ends.length, 1, `END 標記應該剛好 1 個，實際 ${ends.length}。${HOW_TO}`);
  assert.ok(begins[0] < ends[0], 'BEGIN 必須在 END 之前');
});

const block = lines.slice(begins[0] + 1, ends[0]).join('\n');

// 掃描失效偵測：標記若被搬到別處，指紋比對可能變成比錯東西，先確認區塊裡真的是手動建檔路由。
check('凍結區內就是手動建檔路由', () => {
  assert.ok(block.includes("router.post('/', requireAdminAuth, requireAnyResource('manual-enroll', 'enrollments')"),
    '凍結區內找不到 POST / 手動建檔路由：標記可能被移動。' + HOW_TO);
  assert.ok(block.includes("code: 'CREATE_FAILED'"), '凍結區沒有包到路由結尾');
});

check('手動建檔路由內容未變動', () => {
  assert.strictEqual(sha(block), EXPECTED_ROUTE, '手動建檔路由被修改。' + HOW_TO);
});

check('手動建檔頁（ManualEnrollPage.jsx）內容未變動', () => {
  assert.strictEqual(sha(read('client/admin/src/pages/ManualEnrollPage.jsx')), EXPECTED_PAGE,
    '手動建檔頁被修改。' + HOW_TO);
});

console.log(`manual_enroll_frozen_test: ${passed} 項通過`);
