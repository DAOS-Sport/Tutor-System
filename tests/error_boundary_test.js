/**
 * 錯誤邊界必須自報身分
 *
 * 由來：2026-08-27 收到一張「頁面發生錯誤」的截圖，上面只有一行
 * 「Cannot read properties of undefined (reading 'map')」。錯誤邊界掛在
 * main.jsx 最外層，所以側邊欄也一起消失，截圖裡沒有任何線索指出是哪一頁。
 * 把後台 34 條路由在桌機、375px、以及「API 全部失敗」三種狀態各掃一遍，
 * 再逐頁點開詳情彈窗，全部正常 —— 仍然定位不到。
 *
 * 而且當時後台與家長端各有一份 ErrorBoundary，文案一字不差，
 * 連「這是哪一支前端」都分不出來，光是排除這一項就花掉不少時間。
 *
 * 所以這裡守三件事，每一件都直接對應那次排查卡住的地方：
 *   1. 實作只能有一份 —— 兩份會再次漂移成無法分辨
 *   2. 每一支前端掛載時都要帶身分標籤
 *   3. 錯誤畫面上要印出路徑與時間 —— 「一張截圖就能定位」的全部理由
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const SHARED = 'client/shared/ErrorBoundary.jsx';
const MAINS = ['client/admin/src/main.jsx', 'client/liff/src/main.jsx'];

function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (n === 'node_modules' || n === 'dist') continue;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx') || p.endsWith('.js')) out.push(p);
  }
  return out;
}

const FILES = walk(CLIENT);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

check('掃描本身有效（找得到夠多前端檔案）', () => {
  assert.ok(FILES.length >= 100,
    '只掃到 ' + FILES.length + ' 個檔案，路徑可能不對 —— 那會讓下面每一條都假通過');
});

check('ErrorBoundary 的實作全專案只有一份，而且在 shared', () => {
  const impls = FILES
    .filter((f) => /class\s+ErrorBoundary\s+extends/.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepStrictEqual(impls, [SHARED],
    '實作應該只有 ' + SHARED + ' 一份，實際找到：' + (impls.join('、') || '(零份)')
    + '\n       兩份的下場已經發生過一次：文案一字不差，收到截圖時連是哪一支前端都分不出來。');
});

check('每一支前端掛載時都帶身分標籤，而且彼此不同', () => {
  const labels = {};
  for (const m of MAINS) {
    const src = fs.readFileSync(path.join(ROOT, m), 'utf8');
    assert.ok(/from\s+'[^']*shared\/ErrorBoundary\.jsx'/.test(src),
      m + ' 沒有從 shared 匯入 ErrorBoundary');
    const use = src.match(/<ErrorBoundary([^>]*)>/);
    assert.ok(use, m + ' 找不到 <ErrorBoundary> 的掛載點');
    assert.ok(/\bapp=/.test(use[1]),
      m + ' 掛載時沒有帶 app 標籤 —— 錯誤畫面會印不出是哪一支前端：' + use[0]);
    labels[m] = use[1].trim();
  }
  const vals = Object.values(labels);
  assert.notStrictEqual(vals[0], vals[1],
    '兩支前端的 app 標籤一樣（' + vals[0] + '），等於沒有分辨力');
});

check('錯誤畫面要印出路徑與時間（一張截圖就要能定位）', () => {
  const src = fs.readFileSync(path.join(ROOT, SHARED), 'utf8');
  // 只看 render 真正回傳的那段 —— console.error 裡有 where() 不算數，
  // 那是印在主控台，而使用者傳來的是截圖。
  const i = src.indexOf('if (!this.state.error) return this.props.children;');
  assert.ok(i > 0, '找不到 render 的早退，掃描已失效');
  const jsx = src.slice(i);
  assert.ok(/\bwhere\(\)/.test(jsx), '錯誤畫面上沒有印出路徑');
  assert.ok(/\bstamp\(\)/.test(jsx), '錯誤畫面上沒有印出時間');
  assert.ok(/this\.props\.app/.test(jsx), '錯誤畫面上沒有印出是哪一支前端');
  assert.ok(/state\.error/.test(jsx), '錯誤畫面上沒有印出錯誤訊息本身');
});

check('不依賴 Tailwind／外部 CSS（CSS 沒載到也要顯示得出來）', () => {
  const src = fs.readFileSync(path.join(ROOT, SHARED), 'utf8');
  assert.ok(!/className=/.test(src),
    '用了 className —— CSS 沒載到本來就是會走進錯誤邊界的原因之一，'
    + '這支必須全程 inline style');
});

console.log(failures ? '\n' + failures + ' FAILED' : '\nerror_boundary: ALL PASS');
process.exitCode = failures ? 1 : 0;
