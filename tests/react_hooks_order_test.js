/**
 * React hooks 呼叫順序（rules of hooks）。
 *
 * 2026-09-23 正式站「待對帳清單」整頁變成「頁面發生錯誤」，診斷資訊是
 * Minified React error #310（Rendered more hooks than during the previous render）。
 * 原因：ReconcilePage 在 `if (!list) return <LoadingSpinner />` 之後又呼叫了 useMemo。
 * 第一次 render 清單還沒回來，提早 return，hook 少一個；資料回來後 render 走到底，
 * hook 多一個 → React 直接丟錯。只要打開頁面就壞，跟資料內容無關。
 *
 * 專案沒有 eslint（也就沒有 react-hooks/rules-of-hooks），所以這裡用 @babel/parser
 * 做同一件事的最小版本，掃後台與家長端全部 .jsx：
 *   1. 元件（大寫開頭）或自訂 hook（use 開頭）裡，「可能提早 return 的敘述」之後不能再呼叫 hook
 *   2. hook 不能包在 if／迴圈／三元／&& 裡呼叫
 * 只看元件本體這一層：callback、巢狀函式裡的呼叫不算（那些本來就不是 hook 呼叫點）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const parser = require(path.join(ROOT, 'client/admin/node_modules/@babel/parser'));

const SRC_DIRS = ['client/admin/src', 'client/liff/src', 'client/shared']
  .map((d) => path.join(ROOT, d))
  .filter((d) => fs.existsSync(d));

function jsxFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    if (fs.statSync(full).isDirectory()) out.push(...jsxFiles(full));
    else if (/\.(jsx|js)$/.test(name)) out.push(full);
  }
  return out;
}

const isHookName = (name) => /^use[A-Z0-9]/.test(name || '');
function hookNameOf(call) {
  const c = call.callee;
  if (c.type === 'Identifier' && isHookName(c.name)) return c.name;
  // React.useMemo(...)
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier'
      && c.object.type === 'Identifier' && c.object.name === 'React' && isHookName(c.property.name)) {
    return 'React.' + c.property.name;
  }
  return null;
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod']);

// 在一個節點裡找 hook 呼叫，不進入巢狀函式（callback 裡的不算）
function hookCallsIn(node, found = []) {
  if (!node || typeof node.type !== 'string') return found;
  if (FUNCTION_TYPES.has(node.type)) return found;
  if (node.type === 'CallExpression') {
    const name = hookNameOf(node);
    if (name) found.push({ name, line: node.loc.start.line });
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((x) => hookCallsIn(x, found));
    else if (v && typeof v.type === 'string') hookCallsIn(v, found);
  }
  return found;
}

// 敘述裡有沒有 return（不進入巢狀函式）
function containsReturn(node) {
  if (!node || typeof node.type !== 'string') return false;
  if (FUNCTION_TYPES.has(node.type)) return false;
  if (node.type === 'ReturnStatement') return true;
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v) ? v.some(containsReturn) : (v && typeof v.type === 'string' && containsReturn(v))) return true;
  }
  return false;
}

// 條件式裡的 hook：if／迴圈／switch／try 的區塊，或運算式層級的 ?: && ||
const CONDITIONAL_STATEMENTS = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'SwitchStatement']);
function conditionalHookCalls(node, inCond = false, found = []) {
  if (!node || typeof node.type !== 'string') return found;
  if (FUNCTION_TYPES.has(node.type)) return found;
  if (node.type === 'CallExpression' && inCond) {
    const name = hookNameOf(node);
    if (name) found.push({ name, line: node.loc.start.line });
  }
  const cond = inCond
    || CONDITIONAL_STATEMENTS.has(node.type)
    || node.type === 'ConditionalExpression'
    || node.type === 'LogicalExpression';
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    // if 的條件本身、三元／邏輯運算的最左邊一定會執行，不算條件式呼叫
    const alwaysRuns = (node.type === 'IfStatement' && key === 'test')
      || (node.type === 'ConditionalExpression' && key === 'test')
      || (node.type === 'LogicalExpression' && key === 'left')
      || (node.type === 'SwitchStatement' && key === 'discriminant');
    const childCond = alwaysRuns ? inCond : cond;
    if (Array.isArray(v)) v.forEach((x) => conditionalHookCalls(x, childCond, found));
    else if (v && typeof v.type === 'string') conditionalHookCalls(v, childCond, found);
  }
  return found;
}

function functionName(fn, parent) {
  if (fn.id?.name) return fn.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  return null;
}

const violations = [];

// 已知、目前不會炸的例外（另案處理，不要再往這裡加）：
// StaffEditModal 第一行就 `if (!editing) return null`，之前沒有任何 hook。React 18 的
// renderWithHooks 在「上一次 render 一個 hook 都沒有」時走 mount 流程，所以 0 ↔ N 個 hook
// 切換不會丟錯；ReconcilePage 則是前面已有 20 個 hook，N → N+1 才會丟 #310。
// 寫法一樣違反規則，只要在它前面加任何一個 hook 就會跟著壞。
const KNOWN_EXCEPTIONS = new Set([
  'client/admin/src/pages/StaffEditModal.jsx StaffEditModal',
]);

function checkBody(file, name, body) {
  if (!body || body.type !== 'BlockStatement') return; // 箭頭函式直接回傳運算式：沒有提早 return 的問題
  if (KNOWN_EXCEPTIONS.has(`${file} ${name}`)) return;
  let earlyReturnLine = null;
  body.body.forEach((stmt, i) => {
    const isLast = i === body.body.length - 1;
    if (earlyReturnLine != null) {
      for (const h of hookCallsIn(stmt)) {
        violations.push(`${file}:${h.line} ${name} 在第 ${earlyReturnLine} 行可能提早 return 之後呼叫 ${h.name}`);
      }
    }
    for (const h of conditionalHookCalls(stmt)) {
      violations.push(`${file}:${h.line} ${name} 在條件式裡呼叫 ${h.name}`);
    }
    if (earlyReturnLine == null && !isLast && stmt.type !== 'ReturnStatement' && containsReturn(stmt)) {
      earlyReturnLine = stmt.loc.start.line;
    }
  });
}

function walk(file, node, parent) {
  if (!node || typeof node.type !== 'string') return;
  if (FUNCTION_TYPES.has(node.type) && node.type !== 'ClassMethod' && node.type !== 'ObjectMethod') {
    const name = functionName(node, parent);
    if (name && (/^[A-Z]/.test(name) || isHookName(name))) checkBody(file, name, node.body);
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((x) => walk(file, x, node));
    else if (v && typeof v.type === 'string') walk(file, v, node);
  }
}

let scanned = 0;
for (const dir of SRC_DIRS) {
  for (const full of jsxFiles(dir)) {
    const src = fs.readFileSync(full, 'utf8');
    if (!/\buse[A-Z]/.test(src)) continue;
    const ast = parser.parse(src, { sourceType: 'module', plugins: ['jsx'], errorRecovery: false });
    walk(path.relative(ROOT, full).replace(/\\/g, '/'), ast.program, null);
    scanned += 1;
  }
}

// 自我檢查：判準要真的抓得到這次的寫法，也不能把正常寫法當錯
function probe(code) {
  const before = violations.length;
  walk('probe.jsx', parser.parse(code, { sourceType: 'module', plugins: ['jsx'] }).program, null);
  return violations.splice(before);
}
assert.strictEqual(probe(`function A(){ const [l]=useState(null); if(!l) return null; const x=useMemo(()=>1,[l]); return x; }`).length, 1,
  '提早 return 之後的 useMemo 要被抓到（這次的寫法）');
assert.strictEqual(probe(`function A({ok}){ if(ok){ useEffect(()=>{}); } return null; }`).length, 1, 'if 裡的 hook 要被抓到');
assert.strictEqual(probe(`function A(){ const x=useMemo(()=>1,[]); const f=()=>{ if(x) return 1; return useless(); }; if(!x) return null; return x; }`).length, 0,
  '正常寫法：hook 都在提早 return 之前、callback 裡的 return 不算');
assert.strictEqual(probe(`function useThing(){ const a=useRef(); return a; }`).length, 0, '自訂 hook 正常寫法');

assert.ok(scanned > 20, `掃描的檔案數不合理：${scanned}`);
if (violations.length) {
  console.error('React hooks 呼叫順序錯誤（會在正式站變成 React error #310／#300 整頁錯誤）：');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log(`react_hooks_order_test: PASS（掃描 ${scanned} 個檔案）`);
