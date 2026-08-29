/**
 * 找路由裡「用了但這個 scope 沒宣告」的變數 —— ReferenceError 的來源。
 *
 *   node server/scripts/findUndeclaredInRoutes.js server/routes/auth.js [更多檔案…]
 *   不給檔名就掃 server/routes 底下全部。
 *
 * 為什麼需要它：這種錯誤語法是合法的，node --check 抓不到、讀程式也很難看出來
 * （因為同一個名字往往在同檔案的別的 function 裡有宣告），只有真的執行到那一行
 * 才會炸成 500。2026-08-29 就是這樣讓 verify-phone 的 z03_pending 分支對
 * 「有 Z03 待處理記錄」的家庭全部回「查詢失敗」。
 *
 * 作法：以每個 router.xxx(...) 為一個 scope，比對「這個 scope 內的宣告 ＋
 * 模組層級的宣告」。repo 裡沒有 parser（也不為了掃一次去裝），所以是啟發式的：
 * 會有誤報，人要看過。寧可多報也不要漏 —— 漏掉的那個會在正式站上炸。
 *
 * 戰績：2026-08-29 跑第一次，找到 auth.js:714 的 sourceIds（/bind 的
 * uid_conflict 分支），與先前健壯性稽核撞出的 verify-phone studentName 同一類。
 * 驗證方式是把 studentName 那個 bug 放回去，確認掃得出來。
 *
 * 已知會誤報的樣子（看到這些可以先略過，但還是要自己確認一遍）：
 *   · 單獨的 $ —— 樣板字串裡的 ${} 沒洗乾淨
 *   · SQL 關鍵字（AND / WHERE / CASE…）—— 長字串裡的內容
 *   · 一行多個宣告（const a = 1, b = 2）的第二個以後
 *   · regex 字面裡的字，例如 /phone/.test(x) 的 phone
 * 修這些誤報試過一次，反而把噪音從 82 個變成 148 個，所以維持現狀：
 * 它的價值在於「抓得到真的」，不在於「輸出好看」。
 */
const fs = require('fs');
const path = require('path');

const 內建 = new Set(`
Object Array String Number Boolean Date Math JSON RegExp Error TypeError RangeError SyntaxError
Promise Map Set WeakMap WeakSet Symbol BigInt Proxy Reflect Intl Function
console process require module exports __dirname __filename global globalThis
setTimeout setInterval clearTimeout clearInterval setImmediate queueMicrotask
Buffer URL URLSearchParams TextEncoder TextDecoder AbortController fetch structuredClone
undefined NaN Infinity arguments
if else for while do switch case break continue return function var let const class new
try catch finally throw await async yield of in delete void typeof instanceof
export default import extends static get set from as this super null true false
`.trim().split(/\s+/));

/** 把字串與註解換成等長空白，行號才不會跑掉。 */
function 洗掉(src) {
  const out = src.split('');
  let i = 0;
  const 抹 = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const to = e < 0 ? src.length : e; 抹(i, to); i = to; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const to = e < 0 ? src.length : e + 2; 抹(i, to); i = to; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      抹(i + 1, j); i = j + 1; continue;
    }
    if (c === '`') {                       // 樣板字串：${} 裡是真程式碼，要留
      let j = i + 1;
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let d = 1; j += 2;
          while (j < src.length && d > 0) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; }
          continue;
        }
        if (src[j] !== '\n') out[j] = ' ';
        j++;
      }
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

function 收宣告(片段) {
  const s = new Set();
  const 加 = (blob) => {
    for (const part of String(blob || '').split(/[,\s]+/)) {
      // 解構可能寫成 a: b 或 a = 預設值，取真正綁定的那個名字
      const name = part.split(':').pop().split('=')[0].replace(/[^$\w]/g, '');
      if (name && !/^\d/.test(name)) s.add(name);
    }
  };
  const pats = [
    /\b(?:const|let|var)\s*\{([^}]*)\}/g,
    /\b(?:const|let|var)\s*\[([^\]]*)\]/g,
    /\b(?:const|let|var)\s+([$\w]+)/g,
    /\bfunction\s*\*?\s*([$\w]+)/g,
    /\bclass\s+([$\w]+)/g,
    /\bcatch\s*\(\s*([$\w]+)/g,
    /\bfor\s*\(\s*(?:const|let|var)\s+([$\w]+)/g,
    /\(([^()]*)\)\s*=>/g,
    /(^|[^.\w$])([$\w]+)\s*=>/g,
    /\bfunction\s*\*?\s*[$\w]*\s*\(([^()]*)\)/g,
    /\b([$\w]+)\s*\(([^()]*)\)\s*\{/g,
  ];
  for (const re of pats) {
    let m;
    while ((m = re.exec(片段))) 加(m[m.length - 1] === undefined ? m[1] : m[m.length - 1]);
  }
  // 物件方法簡寫的參數也要收
  let m2;
  const re2 = /\b[$\w]+\s*\(([^()]*)\)\s*\{/g;
  while ((m2 = re2.exec(片段))) 加(m2[1]);
  return s;
}

function 用到的名字(片段, 起始行) {
  const found = new Map();
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(片段))) {
    const name = m[2];
    const tailIdx = m.index + m[0].length;
    if (/^\s*:/.test(片段.slice(tailIdx, tailIdx + 3))) continue;   // 物件 key
    if (!found.has(name)) {
      found.set(name, 起始行 + 片段.slice(0, m.index).split('\n').length - 1);
    }
  }
  return found;
}

function 掃(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = 洗掉(raw);
  const 路由 = [];
  const re = /\brouter\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, d = 1;
    while (i < src.length && d > 0) {
      if (src[i] === '(') d++;
      else if (src[i] === ')') d--;
      i++;
    }
    路由.push({ from: m.index, to: i, 名: m[1] });
    re.lastIndex = i;
  }
  // 模組層級 = 所有路由區塊以外的部分
  let 模組 = '';
  let cur = 0;
  for (const r of 路由) { 模組 += src.slice(cur, r.from); cur = r.to; }
  模組 += src.slice(cur);
  // 模組層級只收「沒有縮排」的頂層宣告。
  // 若把整塊非路由程式碼丟進 收宣告()，其他 function 內部的區域變數也會被
  // 當成模組層級可見 —— 那正好會遮掉我們要找的東西：同名變數在別的 function
  // 裡有宣告、在這個路由裡沒有，就是 ReferenceError 的典型長相。
  const 頂層 = 模組.split(/\r?\n/)
    .filter((l) => /^(?:const|let|var|function|class|async\s+function)\s/.test(l))
    .join('\n');
  // 多行解構的 require 也算頂層可見：
  //   const {
  //     foo,          ← 這幾行有縮排，會被上面的頂層過濾濾掉
  //   } = require('...');
  // 不補這一段的話，整包 require 進來的東西都會被誤報成「沒宣告」。
  let 多行 = '';
  const reReq = /(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*require\s*\(/g;
  let mr;
  while ((mr = reReq.exec(模組))) 多行 += mr[1] + ',';
  const 模組宣告 = 收宣告(頂層 + '\nconst {' + 多行 + '} = 0;');

  const 結果 = [];
  for (const r of 路由) {
    const 片段 = src.slice(r.from, r.to);
    const 起始行 = src.slice(0, r.from).split('\n').length;
    const 本地 = 收宣告(片段);
    for (const [name, line] of 用到的名字(片段, 起始行)) {
      if (內建.has(name) || 模組宣告.has(name) || 本地.has(name)) continue;
      結果.push({ line, name, 路由: r.名 });
    }
  }
  return 結果;
}

const args = process.argv.slice(2);
const files = args.length ? args
  : fs.readdirSync(path.resolve(__dirname, '../routes'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.resolve(__dirname, '../routes', f));

let total = 0;
for (const f of files) {
  const hits = 掃(f);
  if (!hits.length) continue;
  console.log('\n── ' + path.relative(process.cwd(), f) + ' ──');
  for (const h of hits) { console.log('  ' + f.split('/').pop() + ':' + h.line + '  ' + h.name); total++; }
}
console.log('\n共 ' + total + ' 個可疑名字（啟發式，會有誤報，需人工看過）');
process.exitCode = 0;

