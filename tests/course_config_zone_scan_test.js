'use strict';
/**
 * 「不帶定價區就碰 course_type_configs」的棘輪（F-A08 階段 2b）。
 *
 * ── 兩種失敗模式，都是安靜的 ──
 * 分區之後 course_type 在這張表裡不再唯一，於是：
 *   讀：`WHERE course_type = $1` 每區回一列，取 rows[0] → 收到別區的價
 *   寫：`UPDATE ... WHERE course_type = $1` 一次改到所有區 → 調三蘆的價
 *       連松山一起被改掉
 * 兩者都不會報錯。dev 實測（兩區，一對三 4500／6000）：那句 SELECT 回 2 列、
 * rows[0] 是 4500，松山的家長就收到三蘆的價。
 *
 * ── 掃描範圍 ──
 * 第一版只抓 `FROM course_type_configs`，漏掉 JOIN 與所有寫入語句，
 * 報 15 筆但實際是 21 筆。所以這版改成：**任何提到這張表的 SQL 都算**，
 * 前後各看 6 行找 pricing_zone_id。掃描器寧可誤報，不可漏報。
 *
 * ── 為什麼是棘輪 ──
 * 舊查詢還沒改完，讓測試長期紅會訓練大家忽略失敗。所以用已知清單：
 * 冒出清單外的新違規會紅、清單上的改好卻沒調數字也會紅 —— 只能縮小。
 *
 * ── 安全前提 ──
 * 只要全公司只有一個定價區，這些語句仍然只命中一列、行為與分區前相同。
 * 清單歸零前，**正式站不可建立第二個定價區**，新增定價區的 UI 也不可上線。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');

// 這些檔案本來就該直接碰資料表：讀取入口自己，以及建表／遷移。
const EXEMPT = new Set([
  'server/services/courseConfig.js',
  'server/bootstrap/coreSchema.js',
]);

// 已知未改的語句數（相對 repo 根 → 筆數）。只能往下調。
const KNOWN_UNZONED = {
  'server/routes/admin/courseIntros.js': 3,
};

// 先剝行註解再剝區塊註解：反過來的話，行註解裡出現的區塊起始符號
// 會從那裡一路吃到下一個結束符號，把中間的程式碼整段當成註解。
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function scan(src) {
  const lines = stripComments(src).split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('course_type_configs')) continue;
    const window = lines.slice(Math.max(0, i - 6), i + 7).join(' ');
    if (window.includes('pricing_zone_id')) continue;
    const w = window.toUpperCase();
    let verb = 'read';
    if (/UPDATE\s+COURSE_TYPE_CONFIGS/.test(w)) verb = 'UPDATE';
    else if (/INSERT\s+INTO\s+COURSE_TYPE_CONFIGS/.test(w)) verb = 'INSERT';
    else if (/DELETE\s+FROM\s+COURSE_TYPE_CONFIGS/.test(w)) verb = 'DELETE';
    found.push({ line: i + 1, verb });
  }
  return found;
}

const actual = {};
for (const file of walk(SERVER)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (EXEMPT.has(rel)) continue;
  const found = scan(fs.readFileSync(file, 'utf8'));
  if (found.length) actual[rel] = found;
}

let failed = 0;
const fail = (msg) => { failed += 1; console.error('  FAIL ' + msg); };

for (const [file, found] of Object.entries(actual)) {
  const allowed = KNOWN_UNZONED[file] || 0;
  if (found.length > allowed) {
    fail(`${file}: ${found.length} 筆未帶定價區（清單允許 ${allowed}）\n`
      + '       新語句一律要帶 pricing_zone_id，或改走 services/courseConfig。');
  }
}
for (const [file, allowed] of Object.entries(KNOWN_UNZONED)) {
  const n = (actual[file] || []).length;
  if (n < allowed) {
    fail(`${file}: 已修到剩 ${n} 筆（清單寫 ${allowed}）—— 請把 KNOWN_UNZONED 調成 ${n}。\n`
      + '       清單只能縮小，這樣進度才看得見。');
  }
}

const all = Object.values(actual).flat();
const writes = all.filter((x) => x.verb !== 'read').length;
console.log(`  未帶定價區：${all.length} 筆（其中寫入 ${writes} 筆，寫入會一次改到所有區）`);
for (const [f, found] of Object.entries(actual).sort()) {
  const kinds = found.map((x) => x.verb).join(',');
  console.log(`    ${String(found.length).padStart(2)}  ${f}  [${kinds}]`);
}
if (all.length > 0) {
  console.log('  ⚠ 清單歸零前，正式站不可建立第二個定價區，新增定價區的 UI 也不可上線。');
}

if (failed) {
  console.error(`\ncourse_config_zone_scan_test: ${failed} FAILED`);
  process.exit(1);
}
console.log('course_config_zone_scan_test: PASS');
