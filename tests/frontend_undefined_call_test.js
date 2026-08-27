/**
 * 前端兩類「安靜壞掉」的錯誤。
 *
 * 這支測試是實機審計挖出兩個正式站上的 bug 之後補的。兩個都不會有錯誤訊息，
 * 兩個都在開發環境看不到 —— 這正是最貴的那種壞法。
 *
 * ── 第一類：呼叫檔案裡不存在的函式 ──
 * CustomerParentsPage:119 寫 `await load()`，但那個元件裡的函式叫 `reload`（:45），
 * 同檔 :80 / :96 用的也都是 reload。而它包在 try 裡：
 *     try { API 成功 → toast.success → await load()  ← ReferenceError }
 *     catch { toast.error('解除綁定失敗') }
 * 結果是 API 已經解綁成功，畫面卻跳「失敗」、清單不重載、那一列還顯示
 * 「已綁定」—— 櫃檯會以為沒成功而再按一次。
 * 專案沒有 eslint（沒有任何設定檔），所以這種 typo 沒有東西會擋。
 *
 * ── 第二類：把清單 API 的資料當成詳情 API 的資料用 ──
 * EnrollmentsPage:218 寫 `detail.audit_logs.map(...)`，但 audit_logs 只有詳情 API
 * 才回，清單 API 刻意不回（server/routes/admin/enrollments.js:918 的註解寫了原因）。
 * openDetail 先 setDetail(row) 讓彈窗立刻出現、等詳情回來才補上，那個空窗期裡
 * audit_logs 是 undefined → TypeError → ErrorBoundary 接住 → 整頁「頁面發生錯誤」。
 * mock 模式的假資料每一筆都自帶 audit_logs（api/mock.js:178 起），所以開發時
 * 點一百次都不會炸。
 *
 * ── 判準要夠準，不然沒有人會理它 ──
 * 第一版兩條判準都製造了假陽性：把函式參數裡的 props（onConfirm / onSaveDraft）
 * 當成未定義，把外層 `X.Y && X.Y.length > 0 && (...)` 守住的 .map 當成沒防護。
 * 一個會誤報的掃描器，下場是大家學會忽略它 —— 那比沒有測試更糟。
 * 所以下面兩條都放寬到「看得懂實際寫法」為止。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'client/admin/src');

function jsxFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...jsxFiles(full));
    else if (name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

const FILES = jsxFiles(SRC);
const rel = (f) => f.replace(ROOT + '/', '').replace('client/admin/src/', '');

/** 把註解換成等長的空白，這樣行號還對得上原檔。 */
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? l.replace(/[^\s]/g, ' ') : l))
    .join('\n');
}
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

check('掃描本身有效（找得到夠多前端檔案）', () => {
  assert.ok(FILES.length >= 40,
    '只掃到 ' + FILES.length + ' 個 jsx，路徑可能不對 —— 那會讓下面每一條都假通過');
});

check('沒有呼叫檔案裡不存在的本地函式', () => {
  const bad = [];
  for (const f of FILES) {
    const src = blankComments(fs.readFileSync(f, 'utf8'));
    const called = new Map();
    for (const m of src.matchAll(/await\s+([a-z][A-Za-z0-9_]*)\s*\(/g)) {
      if (!called.has(m[1])) called.set(m[1], lineOf(src, m.index));
    }
    // 這個檔案裡「這個名字被綁定過」的所有形式：
    //   function name(...)              一般宣告
    //   const/let/var name =            變數
    //   { name } = / { x: name } =      解構（含改名）
    //   function Comp({ ..., name, ...}) props（可能跨行）
    //   (name) => / name =>             參數
    const boundNames = new Set();
    for (const m of src.matchAll(/function\s+([A-Za-z0-9_]+)/g)) boundNames.add(m[1]);
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=/g)) boundNames.add(m[1]);
    // 所有大括號解構區塊（含函式參數列），逐個取出裡面的識別字
    for (const m of src.matchAll(/\{([^{}]*)\}\s*(?:=|\)|,)/g)) {
      for (const part of m[1].split(',')) {
        const name = part.includes(':') ? part.split(':')[1] : part;
        const clean = name.replace(/=.*/, '').trim();
        if (/^[A-Za-z0-9_]+$/.test(clean)) boundNames.add(clean);
      }
    }
    for (const [name, line] of called) {
      if (!boundNames.has(name)) bad.push(rel(f) + ':' + line + ' -> await ' + name + '()');
    }
  }
  assert.deepStrictEqual(bad, [],
    '這些函式在該檔案裡不存在。包在 try 裡的話 ReferenceError 會被 catch 吃掉，'
    + '症狀是「動作其實成功了，畫面卻說失敗」：\n       ' + bad.join('\n       '));
});

check('詳情資料的陣列欄位一律用 inline 防護', () => {
  // detail / editing 這兩個變數通常先被塞進清單來的那一筆、再被詳情 API 覆蓋，
  // 中間有一段時間欄位是 undefined。
  //
  // 判準刻意是「硬規則」而不是「往前找外層守衛」：第一版用 600 字元的回看視窗，
  // 結果被自己的兄弟運算式騙過去 —— 下面這種寫法會讓回看法誤判成有防護：
  //     {detail.audit_logs && detail.audit_logs.length === 0 && (<li>尚無</li>)}
  //     {detail.audit_logs.map(...)}          ← 其實完全沒被保護
  // mutation 實測：把防護拿掉，回看法仍然全綠。任何「附近有沒有守衛」的
  // 啟發法都分不出「包住」與「剛好在旁邊」，所以不用啟發法。
  //
  // 接受三種形式，共同點是「守衛與 .map 在同一個運算式上，看得出來是綁在一起的」：
  //     (X.Y || []).map(...)
  //     X.Y?.map(...)
  //     {X.Y && X.Y.map(...)}    ← 必須同一行
  // 豁免：只給「守衛就在同一個 JS 語句區塊、而且是明確的型別檢查」的情況。
  // 每一項都要寫得出理由，而且是**自我驗證**的 —— 下面會去確認那個守衛真的還在，
  // 守衛被拿掉的話豁免自動失效，不會變成一張放著爛掉的通行證。
  const EXEMPT = {
    'pages/StaffPage.jsx': {
      expr: 'editing.bio_media',
      guard: 'Array.isArray(editing.bio_media)',
      why: '前一行就是 if (editing.bio_media_dirty && Array.isArray(editing.bio_media))，'
        + '而且這是 JS 語句不是 JSX —— JSX 的兄弟運算式騙得過回看法，if 區塊騙不過。',
    },
  };

  const bad = [];
  for (const f of FILES) {
    const src = blankComments(fs.readFileSync(f, 'utf8'));
    const ex = EXEMPT[rel(f)];
    for (const m of src.matchAll(/\b(detail|editing)\.([A-Za-z0-9_]+)\.map\s*\(/g)) {
      const expr = m[1] + '.' + m[2];
      if (ex && ex.expr === expr && src.includes(ex.guard)) continue;
      // 第三種接受形式：{X.Y && X.Y.map(...)} —— 守衛在同一行、同一個運算式、
      // 緊鄰 .map。限定「同一行」是刻意的：騙過回看法的那種兄弟運算式
      // （{X.Y && X.Y.length === 0 && (...)} 另起一行才 {X.Y.map(...)}）
      // 一定跨行，所以這個判準關得死。
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const sameLineBefore = src.slice(lineStart, m.index);
      if (sameLineBefore.includes(expr + ' &&')) continue;
      bad.push(rel(f) + ':' + lineOf(src, m.index) + ' -> ' + expr + '.map()');
    }
  }
  assert.deepStrictEqual(bad, [],
    '清單 API 與詳情 API 的欄位不一定一樣，彈窗會先用清單那一筆 render。'
    + '這裡少一個防護就是整頁 ErrorBoundary，而 mock 資料補齊了欄位、'
    + '開發時看不到：\n       ' + bad.join('\n       ')
    + '\n       改法：(X.Y || []).map(...) 或 X.Y?.map(...)');
});

check('豁免清單每一項都還成立，而且寫得出理由', () => {
  // 這一條是給豁免本身用的：守衛被拿掉、或那一行 .map 被改寫掉之後，
  // 豁免就該從清單上移除，否則名單會慢慢變成沒有人看得懂的通行證。
  const EXEMPT = {
    'pages/StaffPage.jsx': {
      expr: 'editing.bio_media',
      guard: 'Array.isArray(editing.bio_media)',
      why: '前一行就是明確的 Array.isArray 型別檢查，且位於 JS 語句而非 JSX',
    },
  };
  for (const [file, spec] of Object.entries(EXEMPT)) {
    const full = path.join(SRC, file);
    assert.ok(fs.existsSync(full), file + ' 已經不存在，請把豁免移除');
    const src = blankComments(fs.readFileSync(full, 'utf8'));
    assert.ok(spec.why && spec.why.length > 15, file + ' 的豁免沒有寫清楚理由');
    assert.ok(src.includes(spec.guard),
      file + ' 的守衛「' + spec.guard + '」已經不在了 —— 豁免失效，'
      + '要嘛把守衛加回來，要嘛改成 inline 防護');
    assert.ok(new RegExp(spec.expr.replace('.', '\\.') + '\\.map\\s*\\(').test(src),
      file + ' 已經沒有裸寫的 ' + spec.expr + '.map()，請把豁免移除');
  }
});

check('後端保證是陣列的欄位，不可以在無人察覺的情況下不再保證', () => {
  // 這條守的是「契約」那一半。前端 61 處屬性鏈陣列操作裡，絕大多數之所以安全，
  // 靠的是 shapeEnrollmentRow 無條件把欄位補成陣列：
  //     students: row.students || []
  // 只要有人把那個 `|| []` 拿掉（欄位在 DB 是 nullable），前端 r.students.join('、')
  // 立刻整頁 ErrorBoundary，而且是在正式站才會遇到 null 的那幾筆上才發生。
  const src = fs.readFileSync(path.join(ROOT, 'server/routes/admin/enrollments.js'), 'utf8');
  const i = src.indexOf('function shapeEnrollmentRow');
  assert.ok(i > 0, '找不到 shapeEnrollmentRow —— 掃描已失效');
  const body = src.slice(i, src.indexOf('\n}', i));
  const guaranteed = new Set(
    [...body.matchAll(/(\w+):\s*row\.\w+\s*\|\|\s*\[\]/g)].map((m) => m[1])
  );
  for (const f of ['students', 'extra_parent_phones']) {
    assert.ok(guaranteed.has(f),
      f + ' 不再被無條件補成陣列。前端有多處直接 .join()/.map() 它，'
      + '拿掉這個保證等於把那些地方全部變成未爆彈：\n       '
      + '要嘛把 `' + f + ': row.' + f + ' || []` 加回來，'
      + '要嘛把每一個使用處都改成有防護的寫法。');
  }
});

check('後端「不保證」的欄位，前端每一處都必須有防護', () => {
  // 契約的另一半。audit_logs 只有詳情 API 才回，清單 API 刻意不回
  // （enrollments.js 的註解寫了原因）。而彈窗會先用清單那一筆 render，
  // 那個空窗期裡它就是 undefined —— 2026-08-26 正式站整頁掛掉就是這樣來的。
  const src = fs.readFileSync(path.join(ROOT, 'server/routes/admin/enrollments.js'), 'utf8');
  const i = src.indexOf('function shapeEnrollmentRow');
  const body = src.slice(i, src.indexOf('\n}', i));
  const unconditional = new RegExp('audit_logs:\\s*\\w+\\.\\w+\\s*\\|\\|\\s*\\[\\]');
  assert.ok(!unconditional.test(body),
    'audit_logs 現在變成無條件保證了 —— 那這條規則要重寫，不是放著不管');

  const bad = [];
  for (const f of FILES) {
    const jsx = blankComments(fs.readFileSync(f, 'utf8'));
    for (const m of jsx.matchAll(/([A-Za-z_$][\w$]*)\.audit_logs\b(?!\s*\|\|)/g)) {
      const owner = m[1];
      const tail = jsx.slice(m.index, m.index + 40);
      if (/audit_logs\?\./.test(tail)) continue;
      // 這兩種寫法本身就是防護，不是「一次未防護的使用」：
      //     {!detail.audit_logs && (載入中…)}
      //     {detail.audit_logs && detail.audit_logs.length === 0 && (…)}
      // 把它們算成違規的話，正確的程式碼永遠無法通過這條 —— 而一條無法通過的
      // 規則最後一定被人整條刪掉。
      if (jsx[m.index - 1] === '!') continue;                      // !X.audit_logs
      if (/^\.audit_logs\s*&&/.test(jsx.slice(m.index + owner.length))) continue;  // X.audit_logs &&                    // X.audit_logs?.map
      if (/\(\s*$/.test(jsx.slice(Math.max(0, m.index - 2), m.index))) continue;  // (X.audit_logs || [])
      const line = lineOf(jsx, m.index);
      const ctx = jsx.slice(Math.max(0, m.index - 220), m.index);
      const guarded = new RegExp(owner + '\\.audit_logs\\s*(?:&&|\\?)').test(ctx)
        || new RegExp('!' + owner + '\\.audit_logs').test(ctx)
        || new RegExp('Array\\.isArray\\(\\s*' + owner + '\\.audit_logs').test(ctx);
      if (!guarded) bad.push(rel(f) + ':' + line + ' -> ' + owner + '.audit_logs');
    }
  }
  assert.deepStrictEqual(bad, [],
    'audit_logs 在清單回應裡不存在，這些地方沒有防護：\n       ' + bad.join('\n       ')
    + '\n       改法：(X.audit_logs || []).map(...) 或 X.audit_logs?.map(...)');
});

console.log(failures ? '\n' + failures + ' FAILED' : '\nfrontend_undefined_call: ALL PASS');
process.exitCode = failures ? 1 : 0;
