/**
 * 救生員動線上的每一個可點元素，手機上都要有 44px 的命中區。
 *
 * 為什麼是這幾個檔：52 位救生員幾乎一定用手機（他們在池畔，不會坐在辦公桌前），
 * 而且多半是濕手、站著、在太陽底下。他們會碰到的畫面就這幾個 ——
 * 首次登入被強制彈出的改密碼視窗、頂欄、簽到驗證、上課紀錄查詢、簽到模式管理。
 *
 * 判準：min-h-[44px]（要配 md:min-h-0，桌機維持原本密度）或 h-11（本來就是 44px）。
 * 桌機不跟著放大是刻意的 —— 桌機使用者一次要看很多列，拉高會讓每頁看到的資料變少。
 *
 * 實測基準（375x812）：撤銷／補簽到／簽到模式切換 44px；改密碼視窗 4 個輸入框
 * 加 2 顆按鈕 44px；「顯示密碼」那一列 label 16px → 44px。最後那一項是
 * checkbox 本體只有 13px、命中區靠 label 撐出來的案例，靜態掃描看不出來，
 * 所以另外針對它寫了一條。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FILES = [
  'client/admin/src/components/ChangePasswordModal.jsx',
  'client/admin/src/components/Header.jsx',
  'client/admin/src/pages/CheckinPage.jsx',
  'client/admin/src/pages/SessionsPage.jsx',
  'client/admin/src/pages/CheckinModesPage.jsx',
  // 共用的日期選擇器。它不在 admin 目錄底下，很容易被漏掉 ——
  // 而簽到驗證與上課紀錄查詢的第一個操作就是它。實測是 38px。
  'client/shared/DateTimePicker.jsx',
];

const EXEMPT_TYPES = {
  checkbox: '命中區靠外層 label 撐出來，不是 input 本身；另有專門的斷言驗那個 label',
  radio: '同 checkbox：命中區在外層 label，不在 input 本身',
  hidden: '根本不會被畫出來，使用者點不到，命中區大小沒有意義',
  file: '原生檔案選擇器，尺寸由瀏覽器決定，我們的 class 蓋不過去',
};

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

/**
 * 抓出 <button ...> / <input ...> 的完整開頭標籤。
 *
 * 不能用 /<button[\s\S]*?>/ —— 屬性裡的箭頭函式 onChange={(e) => ...} 含一個 >，
 * 非貪婪比對會停在那裡，className 就被切掉了，結果整批誤報成「無 className」。
 * 第一版就是這樣，掃出 16 個假陽性。所以改成逐字掃，追蹤大括號深度與引號狀態，
 * 只在深度 0 且不在引號內的 > 收尾。
 */
function controls(src) {
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const out = [];
  const re = /<(button|input)(?=[\s/>])/g;
  let m;
  while ((m = re.exec(clean))) {
    let i = m.index + m[0].length;
    let depth = 0, q = null, end = -1;
    while (i < clean.length) {
      const ch = clean[i];
      if (q) {
        if (ch === q && clean[i - 1] !== '\\') q = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        q = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
      } else if (ch === '>' && depth === 0) {
        end = i; break;
      }
      i++;
    }
    if (end < 0) continue;
    const attrs = clean.slice(m.index + m[0].length, end);
    const line = clean.slice(0, m.index).split('\n').length;
    const cls = (attrs.match(/className=(?:"([^"]*)"|\{`([\s\S]*?)`\})/) || [])
      .slice(1).filter(Boolean)[0] || '';
    const type = (attrs.match(/type=(?:"([a-z]+)"|\{'([a-z]+)'\})/) || [])
      .slice(1).filter(Boolean)[0] || '';
    out.push({ tag: m[1], type, cls, line });
  }
  return out;
}

const BIG_ENOUGH = (cls) => /min-h-\[44px\]|\bh-11\b|\bmin-h-11\b/.test(cls);

check('掃描本身有效（抓得到元素，而且抓得到 className）', () => {
  const empty = FILES.filter((f) => controls(read(f)).length === 0);
  assert.deepStrictEqual(empty, [], '這些檔一個都沒抓到，正則跟不上寫法了：' + empty.join('、'));
  // 專門盯上面那個「箭頭函式截斷」的坑：真的沒有 className 的元素應該很少。
  const all = FILES.flatMap((f) => controls(read(f)));
  const noCls = all.filter((c) => !c.cls).length;
  assert.ok(noCls <= all.length * 0.2,
    all.length + ' 個元素裡有 ' + noCls + ' 個抓不到 className —— '
    + '八成是屬性裡的箭頭函式把標籤切斷了，那會讓下面的清單全是假陽性');
});

check('每個可點元素在手機上都有 44px 命中區', () => {
  const bad = [];
  for (const f of FILES) {
    for (const c of controls(read(f))) {
      if (EXEMPT_TYPES[c.type]) continue;
      if (BIG_ENOUGH(c.cls)) continue;
      bad.push(f.replace('client/admin/src/', '') + ':' + c.line
        + ' <' + c.tag + (c.type ? ' type=' + c.type : '') + '> ' + (c.cls.slice(0, 52) || '(無 className)'));
    }
  }
  assert.deepStrictEqual(bad, [],
    '這些在 375px 上按不準。救生員多半是濕手在池畔操作，'
    + '而其中有些是破壞性動作（撤銷會把整堂 attendance 標成 REVERSED）：\n       '
    + bad.join('\n       '));
});

check('放大只發生在手機，桌機密度不動', () => {
  const bad = [];
  for (const f of FILES) {
    for (const c of controls(read(f))) {
      if (!/min-h-\[44px\]/.test(c.cls)) continue;   // h-11 本來就是固定尺寸，不在此限
      if (/md:min-h-0/.test(c.cls)) continue;
      bad.push(f.replace('client/admin/src/', '') + ':' + c.line + ' ' + c.cls.slice(0, 56));
    }
  }
  assert.deepStrictEqual(bad, [],
    '有 min-h-[44px] 卻沒有 md:min-h-0，等於順手把桌機也拉高了：\n       ' + bad.join('\n       '));
});

check('checkbox 的命中區由外層 label 撐出來', () => {
  const src = read('client/admin/src/components/ChangePasswordModal.jsx');
  assert.ok(/type="checkbox"/.test(src), '前提變了：這個視窗已經沒有 checkbox，這條要重寫');
  const labels = src.match(/<label[^>]*className="[^"]*"/g) || [];
  assert.ok(labels.some((l) => /min-h-\[44px\]/.test(l) && /md:min-h-0/.test(l)),
    '沒有任何 label 有 44px 的高度 —— checkbox 本體只有 13px，命中區只能由 label 提供');
});

check('豁免清單每一項都寫得出理由', () => {
  for (const [t, why] of Object.entries(EXEMPT_TYPES)) {
    assert.ok(why && why.length > 10, t + ' 沒有寫清楚為什麼可以豁免');
  }
});

console.log(failures ? '\n' + failures + ' FAILED' : '\nmobile_touch_target: ALL PASS');
process.exitCode = failures ? 1 : 0;
