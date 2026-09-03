/**
 * 首頁只顯示「這個人真的看得到」的東西
 *
 * 由來：2026-08-27 用臨時救生員帳號實機量 375px 畫面時發現，救生員的首頁長這樣：
 *     部分統計暫時無法載入（顯示為「—」），請稍後再重新整理。
 *     待對帳報名  —   點擊前往對帳      → /admin/reconcile（他沒權限）
 *     進行中課程  —   confirmed + active → /admin/enrollments（他沒權限）
 *
 * 那行提示不是暫時的，是永久的：/enrollments/stats 的 guard 是
 * requireAnyResource('enrollments','refund','reconcile','manual-enroll')，
 * 救生員一項都沒有，永遠 403。一個每天出現、而且永遠不會好的錯誤提示，
 * 會讓人學會忽略所有錯誤提示 —— 包括真的那些。
 *
 * 這裡守三件事：
 *   1. 前端的權限判斷要跟後端 guard 用同一組 resource key（任一邊改了另一邊要跟）
 *   2. 沒權限就不要發那個請求
 *   3. 連不過去的地方不要給連結
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SERVER = read('server/routes/admin/enrollments.js');
const PAGE = read('client/admin/src/pages/DashboardPage.jsx');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

check('掃描本身有效（兩個檔案都找得到關鍵段落）', () => {
  assert.ok(/router\.get\('\/stats'/.test(SERVER), '找不到 /enrollments/stats 路由');
  assert.ok(/canEnrollStats/.test(PAGE), '首頁沒有權限判斷 —— 這條測試會變成假綠');
});

check('前端的權限判斷與後端 guard 用同一組 resource key', () => {
  const m = SERVER.match(/router\.get\('\/stats',[\s\S]{0,200}?requireAnyResource\(([^)]*)\)/);
  assert.ok(m, '解析不到 /stats 的 requireAnyResource —— 掃描已失效');
  const backend = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.ok(backend.length >= 2, '後端 guard 只解析到 ' + backend.length + ' 個 key，掃描可疑');

  const c = PAGE.match(/const canEnrollStats = [^;]+;/);
  assert.ok(c, '找不到 canEnrollStats 的定義');
  const frontend = [...c[0].matchAll(/can\('([^']+)'\)/g)].map((x) => x[1]).sort();

  assert.deepStrictEqual(frontend, backend,
    '兩邊對不上。前端比後端少一個 → 有權限的人看不到格子；'
    + '多一個 → 沒權限的人拿到一行永遠不會好的錯誤提示。\n'
    + '       後端 guard：' + backend.join(', ') + '\n'
    + '       前端判斷　：' + frontend.join(', '));
});

check('沒權限就不要發那個請求', () => {
  assert.ok(/canEnrollStats \?\s*enrollmentsApi\.stats\(\)/.test(PAGE),
    'enrollmentsApi.stats() 沒有被權限判斷包住 —— 救生員每次開首頁都會打一次必然 403 的請求');
  assert.ok(/if \(allowed === null\) return;/.test(PAGE),
    '沒有等權限載入完成就發請求：can() 在未載入時預設回 true，'
    + '救生員仍會先吃一次 403');
});

check('算不出來的格子不顯示，連不過去的地方不給連結', () => {
  assert.ok(/\{canEnrollStats && \(/.test(PAGE),
    '報名相關的格子沒有用權限包起來，救生員會看到兩個永遠是「—」的格子');
  const cards = [...PAGE.matchAll(/<StatCard[\s\S]{0,400}?\/>/g)].map((x) => x[0]);
  assert.ok(cards.length >= 4, '只解析到 ' + cards.length + ' 個 StatCard —— 掃描已失效');
  const hard = cards.filter((c) => /\sto="\//.test(c))
    .map((c) => (c.match(/label="([^"]+)"/) || [])[1] || '?');
  assert.deepStrictEqual(hard, [],
    '這些格子的連結是寫死的，沒權限的人點下去會被 RequireAuth 擋：' + hard.join('、'));
});

console.log(failures ? '\n' + failures + ' FAILED' : '\ndashboard_permission: ALL PASS');
process.exitCode = failures ? 1 : 0;
