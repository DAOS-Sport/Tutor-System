'use strict';
/**
 * LIFF 底部導覽的三處一致性，以及全站用字。
 *
 * 一個分頁要能正常運作，三個地方都得對上：
 *   1. BottomNav.jsx  COACH_TABS/PARENT_TABS[].to  → 按鈕導去哪
 *   2. App.jsx        <Route path>                 → 那個網址有沒有頁面
 *   3. AppLayout.jsx  TAB_PATHS                    → 那頁要不要顯示底部導覽
 *
 * 漏第 2 個 → 點下去空白；漏第 3 個 → 進去之後導覽列消失，使用者被困在該頁。
 * 兩種都不會報錯，只會安靜地壞掉。
 *
 * 用字：全站「記錄」。家長端曾經自相矛盾——入口按鈕寫「查看上課紀錄」，
 * 點進去頁首寫「上課記錄」，同一個東西兩個名字。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIFF = path.join(ROOT, 'client/liff/src');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const navSrc    = read('client/liff/src/components/BottomNav.jsx');
const appSrc    = read('client/liff/src/App.jsx');
const layoutSrc = read('client/liff/src/components/AppLayout.jsx');

function tabsOf(constName) {
  const m = navSrc.match(new RegExp('const ' + constName + ' = \\[([\\s\\S]*?)\\n\\];'));
  if (!m) return null;
  return [...m[1].matchAll(/\{\s*to:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'/g)]
    .map((x) => ({ to: x[1], label: x[2] }));
}

const coachTabs  = tabsOf('COACH_TABS');
const parentTabs = tabsOf('PARENT_TABS');
const routePaths = new Set([...appSrc.matchAll(/<Route\s+path="([^"]+)"/g)].map((x) => x[1]));
const tabPaths = (() => {
  const m = layoutSrc.match(/const TAB_PATHS = \[([\s\S]*?)\];/);
  return m ? new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) : new Set();
})();

check('掃描有效（三份清單都解析得到）', () => {
  assert.ok(coachTabs && coachTabs.length >= 4, '教練分頁只解析到 ' + (coachTabs || []).length + ' 個');
  assert.ok(parentTabs && parentTabs.length >= 3, '家長分頁只解析到 ' + (parentTabs || []).length + ' 個');
  assert.ok(routePaths.size >= 15, 'App.jsx 只解析到 ' + routePaths.size + ' 條路由');
  assert.ok(tabPaths.size >= 8, 'TAB_PATHS 只解析到 ' + tabPaths.size + ' 條');
});

check('每個分頁都有對應路由', () => {
  const missing = [...coachTabs, ...parentTabs].filter((t) => !routePaths.has(t.to));
  assert.deepStrictEqual(missing.map((t) => `${t.label}(${t.to})`), [],
    '這些分頁點下去沒有頁面');
});

check('每個分頁都在 TAB_PATHS 內（否則進去後底部導覽消失）', () => {
  const missing = [...coachTabs, ...parentTabs].filter((t) => !tabPaths.has(t.to));
  assert.deepStrictEqual(missing.map((t) => `${t.label}(${t.to})`), [],
    '這些分頁不在 AppLayout 的 TAB_PATHS 裡，進去之後導覽列會消失、使用者被困住');
});

check('分頁不得同時有返回鍵與分頁高亮', () => {
  // showBackButton 群組裡的路徑，不該同時是分頁。兩者並存時使用者不知道該按哪個。
  const backPaths = new Set();
  for (const m of appSrc.matchAll(/<AppLayout\s+showBackButton[^>]*>([\s\S]*?)<\/Route>/g)) {
    for (const r of m[1].matchAll(/<Route\s+path="([^"]+)"/g)) backPaths.add(r[1]);
  }
  const bad = [...coachTabs, ...parentTabs].filter((t) => backPaths.has(t.to));
  assert.deepStrictEqual(bad.map((t) => t.to), [],
    '這些路徑既是分頁又掛在 showBackButton 群組下');
});

check('教練端五個分頁，順序與名稱符合 Owner 指定', () => {
  assert.strictEqual(coachTabs.length, 5, '教練分頁不是 5 個');
  assert.deepStrictEqual(coachTabs.map((t) => t.label),
    ['首頁', '報名記錄', '排課', '授課記錄', '個人']);
  assert.ok(/5:\s*'grid-cols-5'/.test(navSrc), 'COL_MAP 沒有 5 欄');
});

check('分頁標籤不換行（四個中文字在五欄下會被壓成兩行）', () => {
  const spans = navSrc.match(/<span className="[^"]*font-medium">/g) || [];
  assert.ok(spans.length >= 2, '掃描失效：只找到 ' + spans.length + ' 個標籤 span');
  const bad = spans.filter((s) => !/whitespace-nowrap/.test(s));
  assert.deepStrictEqual(bad, [], '這些標籤 span 少了 whitespace-nowrap');
});

check('全站用字統一「記錄」，不得再出現「紀錄」', () => {
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(jsx?|tsx?)$/.test(e.name)) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((ln, i) => {
        if (ln.includes('紀錄')) hits.push(path.relative(ROOT, p).replace(/\\/g, '/') + ':' + (i + 1));
      });
    }
  })(LIFF);
  assert.deepStrictEqual(hits, [],
    '仍有「紀錄」：\n       ' + hits.join('\n       ')
    + '\n       家長端曾經入口寫「查看上課紀錄」、頁首寫「上課記錄」，同一個東西兩個名字。');
});

check('掃描有效：確實掃到檔案（避免走訪失敗變成假綠燈）', () => {
  let n = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?)$/.test(e.name)) n += 1;
    }
  })(LIFF);
  assert.ok(n >= 40, '只走訪到 ' + n + ' 個檔案，走訪失敗');
  assert.ok(fs.readFileSync(path.join(LIFF, 'App.jsx'), 'utf8').includes('記錄'),
    'App.jsx 讀不到「記錄」——掃描邏輯有問題');
});

if (failed) { console.error('liff_nav_consistency_test: ' + failed + ' failed'); process.exit(1); }
console.log('liff_nav_consistency_test: all passed');
