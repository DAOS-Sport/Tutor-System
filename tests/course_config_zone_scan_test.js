'use strict';
/**
 * 「不帶定價區就讀 course_type_configs」的棘輪（F-A08 階段 2b）。
 *
 * ── 這支存在的理由 ──
 * 階段 1 把 course_type_configs 的主鍵換成 (pricing_zone_id, course_type)。
 * 在那之前，`WHERE course_type = $1` 保證回一列；之後它會**每個定價區回一列**，
 * 而所有呼叫端都是直接取 rows[0]。
 *
 * dev 實測（兩個區、一對三分別 4500 / 6000）：
 *     SELECT ... FROM course_type_configs WHERE course_type = 3   → 2 列
 *     rows[0].base_price = 4500
 * 家長在松山報一對三、應收 6000，卻可能收到 4500，而且沒有任何錯誤訊息。
 * 這就是這次要消滅的「錯得很安靜」。
 *
 * ── 為什麼是棘輪而不是直接紅 ──
 * 現在還有一批舊查詢沒改完。讓測試長期紅會訓練大家忽略失敗，比沒有測試更糟。
 * 所以用一份「已知未改」清單：
 *   - 冒出清單以外的新違規 → 紅（不准再新增）
 *   - 清單上的檔案改好了卻沒把數字調下來 → 紅（強迫清單只能縮小）
 * 清單歸零時，這支就變成純粹的防再犯。
 *
 * ── 安全前提 ──
 * 只要全公司只有一個定價區，這些查詢仍然只回一列、行為與分區前完全相同。
 * 所以在清單歸零之前，**正式站不可以建立第二個定價區**。
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

// 已知未改的查詢數（相對 repo 根的路徑 → 筆數）。只能往下調，不能往上。
const KNOWN_UNZONED = {
  'server/services/courseTypeSchedule.js': 1,
  'server/routes/admin/courseIntros.js': 3,
  'server/routes/admin/courseTypes.js': 4,
  'server/routes/admin/groupOrders.js': 1,
  'server/routes/admin/enrollments.js': 2,
  'server/routes/courses.js': 2,
  'server/routes/groupOrders.js': 1,
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 一句 SQL 常常跨好幾行，所以往後看 6 行找 pricing_zone_id。
function countUnzoned(src) {
  const lines = src.split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('FROM course_type_configs')) continue;
    const window = lines.slice(i, i + 6).join(' ');
    if (!window.includes('pricing_zone_id')) n += 1;
  }
  return n;
}

const actual = {};
for (const file of walk(SERVER)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (EXEMPT.has(rel)) continue;
  const n = countUnzoned(fs.readFileSync(file, 'utf8'));
  if (n > 0) actual[rel] = n;
}

let failed = 0;
const fail = (msg) => { failed += 1; console.error('  FAIL ' + msg); };

for (const [file, n] of Object.entries(actual)) {
  const allowed = KNOWN_UNZONED[file] || 0;
  if (n > allowed) {
    fail(`${file}: ${n} 筆未帶定價區的查詢，清單只允許 ${allowed} 筆\n`
      + '       新增的查詢一律要帶 pricing_zone_id，或改走 services/courseConfig。');
  }
}
for (const [file, allowed] of Object.entries(KNOWN_UNZONED)) {
  const n = actual[file] || 0;
  if (n < allowed) {
    fail(`${file}: 已修到剩 ${n} 筆（清單寫 ${allowed}）—— 請把 KNOWN_UNZONED 調成 ${n}，\n`
      + '       清單只能縮小，這樣進度才看得見。');
  }
}

const remaining = Object.values(actual).reduce((a, b) => a + b, 0);
const listed = Object.values(KNOWN_UNZONED).reduce((a, b) => a + b, 0);
console.log(`  未帶定價區的查詢：${remaining} 筆（清單 ${listed} 筆）`);
for (const [f, n] of Object.entries(actual).sort()) console.log(`    ${n}  ${f}`);
if (remaining > 0) {
  console.log('  ⚠ 清單歸零前，正式站不可建立第二個定價區（單一區時這些查詢仍只回一列）。');
}

if (failed) {
  console.error(`\ncourse_config_zone_scan_test: ${failed} FAILED`);
  process.exit(1);
}
console.log('course_config_zone_scan_test: PASS');
