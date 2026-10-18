/**
 * 篩選列的手機規則不得再漏掉（2026-08-26）
 *
 * 背景：client/admin/src/components/FilterBar.jsx 已經有一套手機處理 ——
 * 手機收合成一列「篩選 + 生效條件數」、展開是單欄滿版（左右切齊）、
 * md 以上維持原本的橫排。但站上有一半的篩選列是各頁自己手搓的 flex-wrap 橫排，
 * 完全沒拿到那套處理。
 *
 * 這種壞法不會有人回報成 bug：桌機看永遠是對的，只有在 375px 上才會露出來，
 * 而且症狀是「醜」不是「壞掉」—— 欄位各自帶自己的 w-[168px] / w-56 / min-w-[240px]，
 * 折行後右緣停在三四個不同的位置（實測上課紀錄查詢是 304 / 189 / 346），
 * 或是九個欄位一路展開約 700px、吃掉整個螢幕，資料要捲過它才看得到。
 *
 * 所以這支盯的是一條結構性質，不是某一頁的畫面：
 *   凡是「橫排（flex + flex-wrap）且裡面有表單控制項」的工具列，
 *   要嘛收編進 FilterBar，要嘛自己帶手機規則（md: 斷點 + w-full/md:w- 或
 *   flex-1/md:flex- 的配對）。
 *
 * 白名單是遞減式的：每一項都要寫得出理由，而且數量必須「剛好相等」——
 * 多了是退步，少了代表名單過期（有人修好了卻沒把名單改掉），兩種都判失敗。
 * 名單只會往下掉，不會往上長。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADMIN = path.join(ROOT, 'client/admin/src');
const PAGES = path.join(ADMIN, 'pages');
const FILTER_BAR = path.join(ADMIN, 'components/FilterBar.jsx');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

/* ────────────────────────────────────────────────────────────────
   極小的 JSX 掃描器
   專案沒有 eslint、也沒有 AST 工具鏈可用，但純字串比對在這裡會出事：
   屬性裡有箭頭函式（(e) => 大括號區塊）、JSX 註解本身是大括號包住的區塊註解、
   模板字串裡還有 ${cond ? 'a' : 'b'}、className 字串裡也可能出現斜線與星號。
   所以最少要會跳字串、跳大括號、跳註解，並且能配對收尾標籤。
   （這段刻意不寫出「斜線星星星斜線」那四個字元 —— 寫進區塊註解裡會把註解提前關掉，
     這支測試就會變成 SyntaxError。）
   ──────────────────────────────────────────────────────────────── */

function skipString(s, i) {
  const q = s[i]; i++;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    // 模板字串裡的 ${...} 可能再包字串或大括號，要遞迴跳過
    if (q === '`' && s[i] === '$' && s[i + 1] === '{') { i = skipBraces(s, i + 1); continue; }
    if (s[i] === q) return i + 1;
    i++;
  }
  return i;
}

function skipBraces(s, i) {
  let d = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); continue; }
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); if (e < 0) return s.length; i = e; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); if (e < 0) return s.length; i = e + 2; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i + 1; }
    i++;
  }
  return i;
}

// s[i] === '<'：回傳這個開標籤的 '>' 索引與是否自封閉
function endOfTag(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(s, j); continue; }
    if (c === '{') { j = skipBraces(s, j); continue; }
    if (c === '>') return { end: j, self: s[j - 1] === '/' };
    j++;
  }
  return { end: s.length - 1, self: false };
}

// 從開標籤起點 i 抓出整個元素（含子樹）。closed=false 代表配對失敗 → 掃描器壞了
function elementText(s, i, name) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(s, j); continue; }
    if (c === '{') { j = skipBraces(s, j); continue; }
    if (c !== '<') { j++; continue; }
    if (s.startsWith('</' + name, j) && /^[\s>]/.test(s[j + 2 + name.length] || '')) {
      depth--;
      const gt = s.indexOf('>', j);
      if (depth <= 0) return { text: s.slice(i, gt + 1), closed: true };
      j = gt + 1; continue;
    }
    const t = endOfTag(s, j);
    if (s.startsWith('<' + name, j) && /^[\s/>]/.test(s[j + 1 + name.length] || '')) {
      if (!t.self) depth++;
    }
    j = t.end + 1;
  }
  return { text: s.slice(i), closed: false };
}

// 工具列的判準：flex + flex-wrap（無斷點前綴，也就是「手機上就會橫排折行」）
// 且子樹裡真的有表單控制項。純按鈕列（分頁 pill、檢視切換）不算——
// 那些本來就該自然折行，強制滿版只會變成一顆一列。
const CONTROL_RE = /<(select|input|textarea|DateTimePicker|VenueMultiSelect)\b/;
const OPEN_RE = /<(div|form|fieldset)\s[^]{0,400}?className="([^"]*)"/g;

function toolbarsIn(src) {
  const out = [];
  OPEN_RE.lastIndex = 0;
  let m;
  while ((m = OPEN_RE.exec(src))) {
    const cls = m[2];
    OPEN_RE.lastIndex = m.index + 1;
    if (!/(^|\s)flex(\s|$)/.test(cls)) continue;
    if (!/(^|\s)flex-wrap(\s|$)/.test(cls)) continue;
    const el = elementText(src, m.index, m[1]);
    if (!CONTROL_RE.test(el.text)) continue;
    out.push({
      line: src.slice(0, m.index).split('\n').length,
      cls,
      text: el.text,
      closed: el.closed,
      openLen: (m[0] || '').length,
    });
  }
  return out;
}

// 手機規則：單欄滿版之後，md 以上要能還原成原本的寬度／彈性，
// 否則就是「為了手機把桌機也改掉了」。所以兩邊都要出現才算數。
function hasMobileRules(text) {
  const widthPair = /\bw-full\b/.test(text) && /\bmd:w-/.test(text);
  const flexPair = /(^|[\s"'`])flex-1\b/.test(text) && /\bmd:flex-/.test(text);
  return widthPair || flexPair;
}

function listPages() {
  return fs.readdirSync(PAGES, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? fs.readdirSync(path.join(PAGES, d.name))
          .filter((n) => n.endsWith('.jsx')).map((n) => d.name + '/' + n)
      : (d.name.endsWith('.jsx') ? [d.name] : []));
}

/* ────────────────────────────────────────────────────────────────
   遞減式白名單
   每一項寫的是「這個檔案還有幾個沒套手機規則的橫排工具列，以及為什麼還沒動」。
   數量必須剛好相等：修好了要調降或刪掉這一項，新增了會直接判失敗。
   ──────────────────────────────────────────────────────────────── */
const ALLOW = [
  {
    file: 'CourseTypesPage.jsx',
    count: 1,
    why: '「一期堂數」設定列：一顆 w-24 的數字輸入框加一段說明文字，'
       + '不是篩選列而是設定表單的一格。只有一個窄欄位，折行也不會有參差右緣。',
  },
  {
    file: 'ManualEnrollPage.jsx',
    count: 1,
    why: '學員多選的 chip 群（label 包 checkbox）。本質是 chip 不是欄位列，'
       + '強制單欄滿版會變成一位學員一列，比參差右緣更難用。',
  },
  {
    file: 'RagicZ03Page.jsx',
    count: 2,
    why: '兩處都是這一輪未列入的頁面：一處是卡片內「只修正姓名」的行內編輯列，'
       + '另一處是狀態 pill + 搜尋列（與 Ragic 暫存區同型，下一輪一起處理）。',
  },
  {
    file: 'StaffEditModal.jsx',
    count: 1,
    why: '標籤輸入器內部（chip + 自由輸入）的實作，不是頁面層級的工具列；'
       + '它已經被彈窗的手機規則包在裡面。',
  },
];

// 這一輪明確要求「要嘛收編、要嘛就地套規則」的 7 頁。
// 收編的兩頁不會在掃描結果裡出現工具列（外框換成 <FilterBar>），
// 其餘五頁的每一個工具列都必須是 OK。
const ADOPTED = ['SessionsPage.jsx', 'EnrollmentsPage.jsx'];
const IN_PLACE = [
  'RefundPage.jsx', 'CheckinPage.jsx', 'CheckinModesPage.jsx',
  'ReportsPage.jsx', 'RagicStagingPage.jsx',
];

const pages = listPages();
const scan = new Map(); // file -> toolbars[]
for (const rel of pages) {
  scan.set(rel, toolbarsIn(fs.readFileSync(path.join(PAGES, rel), 'utf8')));
}
const allBars = [...scan.values()].flat();

check('掃描器本身還活著（頁面數、工具列數、標籤配對）', () => {
  assert.ok(pages.length >= 40, '只掃到 ' + pages.length + ' 個頁面檔 —— 掃描已失效');
  assert.ok(allBars.length >= 10,
    '只解析出 ' + allBars.length + ' 個橫排工具列 —— 判準或掃描器壞了，'
    + '這支測試會變成無聲的假綠');
  const unclosed = allBars.filter((b) => !b.closed);
  assert.deepStrictEqual(unclosed.map((b) => b.line), [],
    '有 ' + unclosed.length + ' 個工具列找不到收尾標籤 —— 掃描器把檔案讀到底了，'
    + '整段文字都會被當成該元素的內容，判斷不可信');
  // 抓到的必須是「一整棵子樹」而不是只有開標籤，否則手機規則永遠掃不到
  const shallow = allBars.filter((b) => b.text.length <= b.openLen + 20);
  assert.deepStrictEqual(shallow.map((b) => b.line), [],
    '有工具列只抓到開標籤、沒有抓到子樹');
});

check('橫排工具列要嘛收編 FilterBar、要嘛自帶手機規則（白名單遞減）', () => {
  const actual = new Map();
  for (const [rel, bars] of scan) {
    const miss = bars.filter((b) => !hasMobileRules(b.text));
    if (miss.length) actual.set(rel, miss);
  }

  const allowed = new Map(ALLOW.map((a) => [a.file, a]));
  const problems = [];

  // 1) 名單外的一律不准
  for (const [rel, miss] of actual) {
    if (allowed.has(rel)) continue;
    problems.push(
      rel + ' 有 ' + miss.length + ' 個橫排工具列沒有手機規則'
      + '（行 ' + miss.map((b) => b.line).join(', ') + '）\n'
      + '         375px 上這種列會各自折行、右緣停在好幾個不同位置。\n'
      + '         請改用 components/FilterBar.jsx（可用 children slot 塞自訂控制項），\n'
      + '         或就地補上 w-full + md:w-… / flex-1 + md:flex-… 的配對。');
  }

  // 2) 名單裡的必須「剛好相等」——少了代表名單過期
  for (const a of ALLOW) {
    const n = (actual.get(a.file) || []).length;
    if (n === a.count) continue;
    problems.push(
      n > a.count
        ? a.file + ' 白名單記 ' + a.count + ' 個，實際 ' + n + ' 個 —— 有新的工具列漏掉手機規則'
        : a.file + ' 白名單記 ' + a.count + ' 個，實際只剩 ' + n + ' 個 —— 名單過期了，'
          + '請把數字調降或整項刪掉（這份名單只能往下掉）');
    if (!fs.existsSync(path.join(PAGES, a.file))) {
      problems.push(a.file + ' 已不存在，請把白名單那一項刪掉');
    }
  }

  assert.deepStrictEqual(problems, [], '\n       ' + problems.join('\n       '));
});

check('這一輪的 7 頁：收編的真的用 FilterBar，就地的每一列都過關', () => {
  for (const rel of ADOPTED) {
    const src = fs.readFileSync(path.join(PAGES, rel), 'utf8');
    assert.ok(/import FilterBar from '\.\.\/components\/FilterBar'/.test(src),
      rel + ' 沒有 import FilterBar —— 說好要收編的頁面又長回自己手搓的篩選列了');
    assert.ok(/<FilterBar[\s>]/.test(src), rel + ' import 了 FilterBar 卻沒有用它');
    const miss = (scan.get(rel) || []).filter((b) => !hasMobileRules(b.text));
    assert.deepStrictEqual(miss.map((b) => b.line), [],
      rel + ' 收編後仍有沒套手機規則的橫排工具列');
  }
  for (const rel of IN_PLACE) {
    const bars = scan.get(rel) || [];
    assert.ok(bars.length >= 1,
      rel + ' 掃不到任何橫排工具列 —— 判準或頁面結構變了，這條已失去意義');
    const miss = bars.filter((b) => !hasMobileRules(b.text));
    assert.deepStrictEqual(miss.map((b) => b.line), [],
      rel + ' 的工具列（行 ' + miss.map((b) => b.line).join(', ') + '）沒有手機規則');
  }
});

check('FilterBar 新加的參數必須向後相容（既有 4 個呼叫端不能壞）', () => {
  const src = fs.readFileSync(FILTER_BAR, 'utf8');

  // 預設值就是「加參數之前硬寫在 JSX 裡的那兩串」，所以不傳參數時輸出逐字相同
  assert.ok(src.includes("const CARD_CLS = 'mb-4 rounded-lg border border-gray-200 bg-white p-3 shadow-sm'"),
    'CARD_CLS 的預設值被改動 —— 既有呼叫端的卡片外框會跟著變');
  assert.ok(src.includes("const ROW_CLS = 'md:flex md:flex-wrap md:items-end'"),
    'ROW_CLS 的預設值被改動 —— 既有呼叫端桌機的排列方式會跟著變');
  assert.ok(/className = CARD_CLS/.test(src) && /rowClassName = ROW_CLS/.test(src),
    'className / rowClassName 沒有預設值 —— 不傳就會渲染出 undefined');
  // 手機端的單欄格線不開放覆寫，那正是要統一的東西
  assert.ok(/grid-cols-1 gap-3 md:mt-0 \$\{rowClassName\}/.test(src),
    '手機端的 grid-cols-1 / gap-3 被移出固定段，覆寫 rowClassName 就能破壞單欄滿版');
  assert.ok(/\{children\}/.test(src), 'FilterBar 少了 children slot');

  // 收編前就在用的 4 頁：不傳 className / rowClassName，才會吃到上面的預設值
  const legacy = ['CustomerStudentsPage.jsx', 'CustomerParentsPage.jsx', 'StaffPage.jsx', 'ReconcilePage.jsx'];
  for (const rel of legacy) {
    const s = fs.readFileSync(path.join(PAGES, rel), 'utf8');
    const m = /<FilterBar[^]*?\/>/.exec(s);
    assert.ok(m, rel + ' 找不到 <FilterBar … /> 呼叫 —— 掃描已失效');
    assert.ok(!/\b(className|rowClassName)=/.test(m[0]),
      rel + ' 的 FilterBar 呼叫傳了 className / rowClassName；'
      + '這 4 頁是加參數前就存在的呼叫端，必須維持吃預設值才證明得了向後相容');
  }
});

check('所有用到 FilterBar 的頁面都有 import 它', () => {
  const bad = [];
  for (const rel of pages) {
    const src = fs.readFileSync(path.join(PAGES, rel), 'utf8');
    if (!/<FilterBar[\s>]/.test(src)) continue;
    if (!/import FilterBar from/.test(src)) bad.push(rel);
  }
  assert.deepStrictEqual(bad, [],
    '用了 <FilterBar> 卻沒 import：' + bad.join(', ') + '（畫面會直接掛在 ErrorBoundary）');
});

console.log(failures ? '\n' + failures + ' 個檢查失敗' : '\n全部通過');
process.exitCode = failures ? 1 : 0;
