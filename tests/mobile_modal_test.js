/**
 * 後台 modal 手機版高度鎖（375×812）
 *
 * 要釘住的病：modal 背景是 `fixed inset-0 flex items-center justify-center`，
 * 面板本身沒有高度上限、內層也不能捲。內容一超過視窗高度，面板會從上下兩端同時
 * 溢出，底部的「確認 / 儲存 / 關閉」被推到畫面外；而背景是 fixed，頁面根本捲不動，
 * 使用者唯一的出路是重整整頁。桌機視窗高，這個病幾乎不會犯到；後台要開放給
 * 52 位在池畔用手機的救生員之後，它會變成每天都撞得到的死路。
 *
 * 判準（對齊 client/admin/src/pages/ReconcilePage.jsx，全站第一個寫對的）：
 *   1. 面板（背景層的直接子元素）要有高度上限 —— max-h-* / maxHeight / h-[…]
 *   2. 背景層內部要有可捲區 —— overflow-y-auto 之類
 * 兩個條件缺一不可：只有上限沒有捲動＝內容被裁掉看不到；
 * 只有捲動沒有上限＝面板照樣長到畫面外，捲的是不存在的東西。
 *
 * 「面板」刻意只看直接子元素，不看整個 block：modal 深處常有自己的 max-h-64
 * 小捲動區（RagicZ02Modal 就有），用整段搜尋會把那種無關的東西誤判成「有做」。
 *
 * ── 白名單規則 ──
 * ALLOW 是遞減清單，只准變短。上面的每一筆都要寫得出「為什麼這支不適用上面的判準」，
 * 而且下面的 staleness 檢查會反過來驗：一旦某筆已經符合判準卻還留在名單上，
 * 一樣判 FAIL。否則名單會慢慢變成沒人敢刪的裝飾品，這條測試就跟著失效。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIR = path.join(ROOT, 'client/admin/src');

/** key = `<相對路徑>#<該檔案中第幾個 modal，0 起算>`；用序號而不是行號，改動上下文才不會整批失效。 */
const ALLOW = {
  'client/admin/src/components/ImageLightbox.jsx#0':
    '全螢幕看圖：內容是單張等比縮放的 <img max-h-[80vh]>，沒有「可捲的內容」這回事；'
    + '關閉鈕是 absolute right-4 top-4 釘在覆蓋層角落，不隨內容被推走，沒有按不到的問題。',
  'client/admin/src/pages/RagicZ01Modal.jsx#0':
    '另一種正確寫法而不是漏修：背景層本身就是 justify-center + overflow-y-auto（注意沒有 '
    + 'items-center），面板 h-fit，整個覆蓋層可捲，工具列在面板頂端一開始就看得到。',
  'client/admin/src/pages/RagicZ02Modal.jsx#0':
    '同 RagicZ01Modal：背景層 justify-center + overflow-y-auto、面板 h-fit，整層可捲。'
    + '（內層那個 max-h-64 是資料表的小捲動區，與面板高度無關，本測試刻意不採計。）',
};

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// ── JSX 掃描：只做標籤配對，不建完整 AST ──
function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (n === 'node_modules' || n === 'dist') continue;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
}

/** 從 start 掃到這個開頭標籤的 '>'。字串與 {…} 內的 '>' 不算（onClick={() => …} 會誤判）。 */
function tagEnd(src, start) {
  let i = start; let q = null;
  while (i < src.length) {
    const c = src[i];
    if (q) { if (c === q && src[i - 1] !== '\\') q = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; i++; continue; }
    if (c === '{') { let d = 1; i++; while (i < src.length && d > 0) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; } continue; }
    if (c === '>') return i;
    i++;
  }
  return -1;
}
const selfClosing = (src, open, end) => /\/\s*$/.test(src.slice(open, end));

/** 取得 `<div …>` 的整段範圍；self=true 代表 `<div … />`（純遮罩，不是 modal）。 */
function blockOf(src, open) {
  const te = tagEnd(src, open + 4);
  if (te < 0) return null;
  if (selfClosing(src, open, te)) return { open, te, end: te, self: true };
  let depth = 1; let j = te + 1;
  while (j < src.length && depth > 0) {
    if (src.startsWith('</div>', j)) { depth--; j += 6; continue; }
    if (/^<div[\s>]/.test(src.slice(j, j + 5))) {
      const k = tagEnd(src, j + 4);
      if (k < 0) break;
      if (!selfClosing(src, j, k)) depth++;
      j = k + 1; continue;
    }
    j++;
  }
  return { open, te, end: j - 6, self: false };
}

/** 只回直接子層的開頭標籤字串（跳過整棵子樹，孫子不算）。 */
function directChildTags(src, te, end) {
  const tags = []; let j = te + 1;
  while (j < end) {
    const m = /^<([A-Za-z][A-Za-z0-9]*)[\s>]/.exec(src.slice(j, j + 40));
    if (!m) { j++; continue; }
    const k = tagEnd(src, j + 1 + m[1].length);
    if (k < 0) break;
    tags.push(src.slice(j, k + 1));
    if (selfClosing(src, j, k)) { j = k + 1; continue; }
    let d = 1; let p = k + 1; const close = '</' + m[1] + '>';
    while (p < end && d > 0) {
      if (src.startsWith(close, p)) { d--; p += close.length; continue; }
      if (new RegExp('^<' + m[1] + '[\\s>]').test(src.slice(p, p + m[1].length + 2))) {
        const q = tagEnd(src, p + 1 + m[1].length);
        if (q < 0) break;
        if (!selfClosing(src, p, q)) d++;
        p = q + 1; continue;
      }
      p++;
    }
    j = p;
  }
  return tags;
}

const CAP = /max-h-\[|max-h-(?:screen|full|\d)|maxHeight|\bh-\[\d|height:/;
const SCROLL = /overflow-y-auto|overflow-auto|overflow-y-scroll/;

/** 掃出所有「看起來是 modal」的背景層。 */
function collectModals() {
  const found = [];
  for (const file of walk(SCAN_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    let n = 0;
    for (const m of src.matchAll(/fixed inset-0/g)) {
      const open = src.lastIndexOf('<div', m.index);
      if (open < 0) continue;
      const b = blockOf(src, open);
      if (!b) continue;
      const tag = src.slice(b.open, b.te + 1);
      // modal 的定義：背景層用 flex 排版一個面板，而且真的有內容。
      // 排除純遮罩（Sidebar 的抽屜背景、ManualEnrollPage 的關閉點擊區）—— 那些是
      // `<div className="fixed inset-0 …" />`，沒有子元素，也沒有按鈕會被推出畫面。
      if (b.self || !/\bflex\b/.test(tag)) continue;
      const kids = directChildTags(src, b.te, b.end);
      if (!kids.length) continue;
      found.push({
        key: rel + '#' + n,
        rel,
        line: src.slice(0, b.open).split('\n').length,
        hasCap: kids.some((t) => CAP.test(t)),
        hasScroll: SCROLL.test(src.slice(b.te + 1, b.end)),
        usesDvh: kids.some((t) => /dvh/.test(t)),
      });
      n++;
    }
  }
  return found;
}

const modals = collectModals();

check('掃描本身沒失效', () => {
  assert.ok(modals.length >= 15,
    '只掃到 ' + modals.length + ' 個 modal —— 標籤配對或判斷條件已失效，'
    + '這條測試會變成無聲的假綠。');
  const ref = modals.find((m) => m.rel.endsWith('pages/ReconcilePage.jsx'));
  assert.ok(ref, '找不到對照組 ReconcilePage —— 掃描已失效');
  assert.ok(ref.hasCap && ref.hasScroll && ref.usesDvh,
    '對照組 ReconcilePage 自己都不符合判準，代表判準寫錯了，不是它壞了');
});

check('每個 modal 的面板都要有高度上限 + 可捲內層', () => {
  const bad = modals
    .filter((m) => !(m.hasCap && m.hasScroll))
    .filter((m) => !Object.prototype.hasOwnProperty.call(ALLOW, m.key));
  assert.deepStrictEqual(bad.map((m) => m.rel + ':' + m.line + '（'
    + (m.hasCap ? '' : '面板無高度上限 ') + (m.hasScroll ? '' : '內層不可捲') + '）'), [],
  '這些 modal 在 375×812 上會溢出視窗上下緣，底部按鈕按不到、頁面也捲不動：\n         '
  + bad.map((m) => m.rel + ':' + m.line).join('\n         ')
  + '\n       比照 client/admin/src/pages/ReconcilePage.jsx:372 —— 面板 flex-col + '
  + "style={{ maxHeight: '90dvh' }}，中段 flex-1 overflow-y-auto，頭尾 shrink-0。"
  + '\n       用 dvh 不要用 vh：iOS Safari 的 100vh 含收合中的網址列，會比實際可見區高一截。');
});

check('白名單沒有過期（修好了就要從名單上拿掉）', () => {
  const byKey = new Map(modals.map((m) => [m.key, m]));
  const stale = [];
  for (const key of Object.keys(ALLOW)) {
    const m = byKey.get(key);
    if (!m) { stale.push(key + ' → 掃不到這個 modal（檔案改名或已刪除？）'); continue; }
    if (m.hasCap && m.hasScroll) stale.push(key + ' → 已經符合判準了');
  }
  assert.deepStrictEqual(stale, [],
    'ALLOW 是遞減清單，只能變短：\n         ' + stale.join('\n         ')
    + '\n       留著過期的豁免，名單就會慢慢失去意義，這條測試也跟著失效。');
});

// ── 非阻擋性提示：vh 在 iOS Safari 上會偏高，但這批不在本次修復範圍 ──
const vhOnly = modals.filter((m) => m.hasCap && m.hasScroll && !m.usesDvh);
if (vhOnly.length) {
  console.log('\n  note 下列 modal 有高度上限但用的是 vh／px 而非 dvh（iOS Safari 的 100vh '
    + '含收合中的網址列，實際可見區更矮）。不擋 CI，列出來當待辦：');
  for (const m of vhOnly) console.log('       - ' + m.rel + ':' + m.line);
}

console.log('\n掃到 ' + modals.length + ' 個 modal，豁免 ' + Object.keys(ALLOW).length + ' 個');
if (failures) console.error('\nmobile_modal_test: ' + failures + ' failed');
else console.log('mobile_modal_test: all passed');
process.exitCode = failures ? 1 : 0;
