/**
 * 後台彈窗在手機上要是「從底部升起的面板」（375×812）
 *
 * 要釘住的病：後台每一個彈窗都是 `flex items-center justify-center`，面板浮在畫面
 * 正中央。內容再怎麼收好，「儲存 / 確認 / 送出」這排主要動作都停在螢幕垂直中線附近 ——
 * 單手握 375 寬的手機時，拇指自然覆蓋的是螢幕下三分之一，中線以上每一次都要換手，
 * 或把手機往下滑一截再按。救生員在池畔是濕手、站著、單手；櫃檯對帳是一手拿手機、
 * 一手比對匯款單。這個距離不會被回報成 bug，但它是每一次操作都要付的稅。
 * 置中卡片還有第二個問題：它沒有任何「可以往下滑關掉」的暗示，關閉只剩右上角那顆 ✕。
 *
 * 判準（md = 768px，對齊 client/admin/src/components/ConfirmDialog.jsx）：
 *   1. 覆蓋層 md 以下 `items-end`（貼底），md 以上 `md:items-center`（回到置中）
 *   2. 覆蓋層 md 以下不能有水平內距 —— 有 p-4 / px-4 面板就不是滿版，
 *      左右各留一條遮罩、圓角浮在半空中，那不是 bottom sheet 是「靠下的卡片」
 *   3. 面板 md 以下 `rounded-t-*`（只有上緣圓角，下緣貼齊螢幕邊），
 *      md 以上要有 `md:rounded-*` 把四角圓角接回來（否則桌機的對話框下緣變成直角）
 *   4. 面板 md 以下不能有沒帶 md: 的 `max-w-*` —— 那會讓面板在寬一點的手機
 *      （430 的 15 Pro Max）縮回卡片寬度，不是滿版
 *   5. 面板的高度上限要用 dvh 不是 vh：iOS Safari 的 100vh 含收合中的網址列，
 *      比實際可見區高一截，貼底之後多出來的那一截就是被網址列蓋住的按鈕
 *   6. 要有 grabber（`h-1 w-10 rounded-full`）而且 `md:hidden` ——
 *      行動裝置上「這個可以往下拉」的通用暗示；桌機沒有這個手勢，露出來只是雜訊
 *
 * 為什麼 1 和 3 都要同時驗「md 以下」跟「md 以上」：只驗前者的話，把 `md:items-center`
 * 或 `md:rounded-2xl` 拿掉，桌機會靜靜地變成一個貼在瀏覽器視窗底部、下緣直角的長條，
 * 而手機看起來一切正常 —— 這種壞法在手機上開發時完全看不到。
 *
 * ── 白名單規則 ──
 * ALLOW 是遞減清單，只准變短。名單上每一筆都要寫得出「為什麼這支不該是 bottom sheet」，
 * 而且下面的 staleness 檢查會反過來驗：一旦某筆已經全部符合判準卻還留在名單上，
 * 一樣判 FAIL。否則名單會慢慢變成沒人敢刪的裝飾品，這條測試就跟著失效。
 *
 * 這支跟 tests/mobile_modal_test.js 是兩件事：那支管「高度上限與可捲內層」（內容看不看得完），
 * 這支管「面板從哪裡升起來」（按鈕按不按得到）。掃描邏輯刻意各寫一份、不共用，
 * 免得其中一邊的解析出錯時兩條測試一起變成無聲的假綠。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIR = path.join(ROOT, 'client/admin/src');

/** key = `<相對路徑>#<該檔案中第幾個 overlay，0 起算>`；用序號而不是行號，改動上下文才不會整批失效。 */
const ALLOW = {
  'client/admin/src/components/ImageLightbox.jsx#0':
    '看圖燈箱，不是「次要畫面」。全螢幕黑底 + 置中等比縮放才是看圖該有的樣子，'
    + '收成貼底面板只會讓可視面積更小。它的手機問題是另一種（放不大、看不清匯款末 5 碼），'
    + '已用「放大／再放大／還原」級距 + 放大後可拖曳平移解決，不走 sheet。',
  'client/admin/src/pages/RagicZ01Modal.jsx#0':
    '全螢幕的 Ragic 表單模擬（max-w-6xl 寬表格），是「整頁接管」不是對話框。'
    + '它的覆蓋層本身就是捲軸（flex justify-center + overflow-y-auto，面板 h-fit），'
    + '改成 items-end 會讓超出上緣的內容捲不到；而且收進 85dvh 只會讓本來就很擠的'
    + '寬表格更沒有垂直空間。',
  'client/admin/src/pages/RagicZ02Modal.jsx#0':
    '同 RagicZ01Modal：全螢幕 Ragic 表單模擬（max-w-7xl），覆蓋層自己是捲軸、面板 h-fit。',
};

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// ── JSX 掃描 ──────────────────────────────────────────────────────────────
// 只做標籤配對，不建 AST。屬性裡的箭頭函式 onClick={(e) => …} 含一個 '>'，
// 用非貪婪比對會在那裡把標籤切斷，所以逐字掃、追蹤引號與大括號深度。

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
}

/** 從 from 開始找這個開頭標籤的 '>'；引號內與 {…} 內的 '>' 不算。 */
function endOfTag(src, from) {
  let i = from;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }
    if (c === '{') {
      let depth = 1; i++;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      continue;
    }
    if (c === '>') return i;
    i++;
  }
  return -1;
}

const isSelfClosing = (tag) => /\/\s*$/.test(tag.slice(0, -1));

/** `<div …>` 的範圍：{ tagEnd, blockEnd }；self-closing 回 null（純遮罩，不是彈窗）。 */
function divBlock(src, open) {
  const te = endOfTag(src, open + 4);
  if (te < 0) return null;
  if (isSelfClosing(src.slice(open, te + 1))) return null;
  let depth = 1;
  let j = te + 1;
  while (j < src.length && depth > 0) {
    if (src.startsWith('</div>', j)) { depth--; j += 6; continue; }
    if (/^<div[\s>]/.test(src.slice(j, j + 5))) {
      const k = endOfTag(src, j + 4);
      if (k < 0) break;
      if (!isSelfClosing(src.slice(j, k + 1))) depth++;
      j = k + 1; continue;
    }
    j++;
  }
  return { tagEnd: te, blockEnd: j - 6 };
}

/** 直接子層的開頭標籤（整棵子樹跳過，孫子不算）。 */
function directChildren(src, tagEnd, blockEnd) {
  const tags = [];
  let j = tagEnd + 1;
  while (j < blockEnd) {
    const m = /^<([A-Za-z][A-Za-z0-9]*)[\s>]/.exec(src.slice(j, j + 40));
    if (!m) { j++; continue; }
    const k = endOfTag(src, j + 1 + m[1].length);
    if (k < 0) break;
    const tag = src.slice(j, k + 1);
    tags.push(tag);
    if (isSelfClosing(tag)) { j = k + 1; continue; }
    // 跳過整棵子樹
    const close = '</' + m[1] + '>';
    let depth = 1;
    let p = k + 1;
    while (p < blockEnd && depth > 0) {
      if (src.startsWith(close, p)) { depth--; p += close.length; continue; }
      if (new RegExp('^<' + m[1] + '[\\s>]').test(src.slice(p, p + m[1].length + 2))) {
        const q = endOfTag(src, p + 1 + m[1].length);
        if (q < 0) break;
        if (!isSelfClosing(src.slice(p, q + 1))) depth++;
        p = q + 1; continue;
      }
      p++;
    }
    j = p;
  }
  return tags;
}

// ── 判準 ─────────────────────────────────────────────────────────────────
// 前置 (?<![:\w-]) 是「這個 class 沒有被任何變體前綴修飾」：`md:items-center` 的
// items-center 前面是 ':'，`group-hover:rounded-t-xl` 也一樣，都不算「md 以下就生效」。
const BARE = (cls) => new RegExp('(?<![:\\w-])' + cls);

const OVERLAY_BOTTOM = BARE('items-end\\b');           // 貼底（bottom-0 走另一條，見下）
const OVERLAY_BOTTOM_ALT = BARE('bottom-0\\b');
const OVERLAY_MD_CENTER = /\bmd:items-center\b/;
const OVERLAY_MOBILE_PAD = BARE('p-\\d|(?<![:\\w-])px-\\d');
const PANEL_ROUNDED_TOP = BARE('rounded-t(?:-|\\b)');
const PANEL_MD_ROUNDED = /\bmd:rounded-(?:none|sm|md|lg|xl|2xl|3xl|full|\[)/;
const PANEL_MOBILE_MAXW = BARE('max-w-(?!none)');
const PANEL_DVH_CAP = /(?<![:\w-])(?:max-)?h-\[[^\]]*dvh\]/;
const GRABBER = /h-1 w-10 rounded-full|h-1 w-10 shrink-0 rounded-full/;

/** grabber 自己或包住它的那一層要有 md:hidden：桌機沒有下拉手勢，露出來只是雜訊。 */
function grabberHiddenOnDesktop(block) {
  const i = block.search(GRABBER);
  if (i < 0) return false;
  // 往前看一段：md:hidden 可能寫在 grabber 自己身上，也可能寫在它外層那個
  // 「跟著彩色標頭上色」的包裝層（ManualDeductionPage 就是這種）。
  return /md:hidden/.test(block.slice(Math.max(0, i - 300), i + 200));
}

function collect() {
  const found = [];
  for (const file of walk(SCAN_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    let n = 0;
    for (const m of src.matchAll(/fixed inset-0/g)) {
      const open = src.lastIndexOf('<div', m.index);
      if (open < 0) continue;
      const b = divBlock(src, open);
      if (!b) continue;                                   // self-closing = 純點擊區
      const overlay = src.slice(open, b.tagEnd + 1);
      if (!/\bflex\b/.test(overlay)) continue;            // 不排版面板的 = 純遮罩（Sidebar 抽屜）
      const kids = directChildren(src, b.tagEnd, b.blockEnd);
      if (!kids.length) continue;
      const block = src.slice(open, b.blockEnd);
      // 面板 = 第一個「看起來像面板」的直接子元素：有上緣圓角，或有高度上限。
      const panel = kids.find((t) => PANEL_ROUNDED_TOP.test(t))
        || kids.find((t) => /(?<![:\w-])(?:max-)?h-\[|max-h-(?:screen|full)/.test(t))
        || null;
      found.push({
        key: rel + '#' + n,
        rel,
        line: src.slice(0, open).split('\n').length,
        overlay,
        panel,
        block,
        src,
      });
      n++;
    }
  }
  return found;
}

/** 回傳這支彈窗違反的判準清單；空陣列 = 完全符合。 */
function violations(m) {
  const bad = [];
  if (!(OVERLAY_BOTTOM.test(m.overlay) || OVERLAY_BOTTOM_ALT.test(m.overlay))) {
    bad.push('覆蓋層 md 以下沒有貼底（缺 items-end / bottom-0）');
  }
  if (!OVERLAY_MD_CENTER.test(m.overlay)) {
    bad.push('覆蓋層缺 md:items-center —— 桌機不會回到置中');
  }
  if (OVERLAY_MOBILE_PAD.test(m.overlay)) {
    bad.push('覆蓋層 md 以下有水平內距（p-N / px-N 沒帶 md:），面板不是滿版');
  }
  if (!m.panel) {
    bad.push('找不到面板（覆蓋層的直接子元素裡沒有上緣圓角也沒有高度上限）');
    return bad;
  }
  if (!PANEL_ROUNDED_TOP.test(m.panel)) bad.push('面板 md 以下缺 rounded-t-*');
  // 桌機圓角允許由 prop 帶進來（Sheet.jsx 的 desktopRounded，各呼叫端傳自己的
  // md:rounded-lg / md:rounded-xl）。這種面板的 className 是樣板字串，字面值不在
  // 標籤裡而在同檔的預設值上，所以標籤有 ${…} 時退一步看整個檔案。
  // 只對這一條放寬：其餘判準（貼底、滿版、dvh、grabber）都不該被參數化。
  const roundedScope = /\$\{/.test(m.panel) ? m.src : m.panel;
  if (!PANEL_MD_ROUNDED.test(roundedScope)) bad.push('面板缺 md:rounded-* —— 桌機對話框下緣會變直角');
  if (PANEL_MOBILE_MAXW.test(m.panel)) bad.push('面板有沒帶 md: 的 max-w-*，寬螢幕手機上不是滿版');
  if (!PANEL_DVH_CAP.test(m.panel)) bad.push('面板 md 以下沒有 dvh 高度上限');
  if (!grabberHiddenOnDesktop(m.block)) bad.push('缺 grabber（h-1 w-10 rounded-full + md:hidden）');
  return bad;
}

const modals = collect();

check('掃描本身沒失效', () => {
  assert.ok(modals.length >= 15,
    '只掃到 ' + modals.length + ' 個 overlay —— 標籤配對或篩選條件已失效，'
    + '這條測試會變成無聲的假綠。');
  const ref = modals.find((m) => m.rel.endsWith('components/ConfirmDialog.jsx'));
  assert.ok(ref, '找不到對照組 ConfirmDialog —— 掃描已失效');
  assert.deepStrictEqual(violations(ref), [],
    '對照組 ConfirmDialog 自己都不符合判準，代表判準寫錯了，不是它壞了');
});

check('每個彈窗 md 以下都要是貼底面板、md 以上回到置中', () => {
  const bad = modals
    .filter((m) => !Object.prototype.hasOwnProperty.call(ALLOW, m.key))
    .map((m) => ({ m, v: violations(m) }))
    .filter((x) => x.v.length);
  assert.deepStrictEqual(bad.map((x) => x.m.rel + ':' + x.m.line + ' → ' + x.v.join('；')), [],
    '這些彈窗在 375px 上仍然是置中卡片，主要動作落在拇指構不到的螢幕中線：\n         '
    + bad.map((x) => x.m.rel + ':' + x.m.line + '\n           - ' + x.v.join('\n           - ')).join('\n         ')
    + '\n       比照 client/admin/src/components/ConfirmDialog.jsx：'
    + '\n         覆蓋層 flex items-end justify-center md:items-center md:px-4'
    + '\n         面板   flex max-h-[85dvh] w-full flex-col rounded-t-2xl … md:max-h-[90dvh] md:max-w-md md:rounded-2xl'
    + '\n         grabber <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-gray-300 md:hidden" />'
    + '\n       新的彈窗可以直接用 client/admin/src/components/Sheet.jsx，預設就是對的。');
});

check('白名單沒有過期（改好了就要從名單上拿掉）', () => {
  const byKey = new Map(modals.map((m) => [m.key, m]));
  const stale = [];
  for (const key of Object.keys(ALLOW)) {
    const m = byKey.get(key);
    if (!m) { stale.push(key + ' → 掃不到這個 overlay（檔案改名或已刪除？）'); continue; }
    if (!violations(m).length) stale.push(key + ' → 已經完全符合判準了');
  }
  assert.deepStrictEqual(stale, [],
    'ALLOW 是遞減清單，只能變短：\n         ' + stale.join('\n         ')
    + '\n       留著過期的豁免，名單就會慢慢失去意義，這條測試也跟著失效。');
});

check('豁免的三支都寫得出理由', () => {
  const thin = Object.entries(ALLOW).filter(([, why]) => !why || why.length < 30).map(([k]) => k);
  assert.deepStrictEqual(thin, [],
    '白名單的理由太短，看不出「為什麼這支不該是 bottom sheet」：\n         ' + thin.join('\n         '));
});

console.log('\n掃到 ' + modals.length + ' 個 overlay，豁免 ' + Object.keys(ALLOW).length + ' 個，'
  + '判定為 bottom sheet ' + (modals.length - Object.keys(ALLOW).length) + ' 個');
if (failures) console.error('\nmobile_sheet_test: ' + failures + ' failed');
else console.log('mobile_sheet_test: all passed');
process.exitCode = failures ? 1 : 0;
