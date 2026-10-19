'use strict';
// xlsx（約 150 KB gzip）只在按下匯出時才載入（#15 OPT-3）。
// 鎖住兩件事：
//   1. 後台只有 csvExport.js（給凍結的上課紀錄頁用）可以靜態 import xlsx，其他檔案一律不行。
//   2. tableExport.js 的動態載入要走 importWithRetry，部署後舊分頁才不會卡在 chunk 404。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'client', 'admin', 'src');
const STATIC_ALLOWED = new Set(['utils/csvExport.js']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

const staticImport = /^\s*import\s[^;]*?from\s+['"]xlsx['"]/m;
const offenders = walk(SRC)
  .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
  .filter((rel) => !STATIC_ALLOWED.has(rel) && staticImport.test(fs.readFileSync(path.join(SRC, rel), 'utf8')));
assert.deepStrictEqual(offenders, [], '這些檔案靜態 import xlsx，會把它拉回首屏：' + offenders.join(', '));

const tableExport = fs.readFileSync(path.join(SRC, 'utils', 'tableExport.js'), 'utf8');
assert.match(tableExport, /importWithRetry\(\s*\(\)\s*=>\s*import\(\s*['"]xlsx['"]\s*\)\s*\)/,
  'tableExport.js 的 import(\'xlsx\') 要包在 importWithRetry 裡');
assert.doesNotMatch(tableExport.replace(/importWithRetry\(\s*\(\)\s*=>\s*import\(\s*['"]xlsx['"]\s*\)\s*\)/g, ''),
  /import\(\s*['"]xlsx['"]\s*\)/, 'tableExport.js 還有沒包 importWithRetry 的 import(\'xlsx\')');

console.log('lazy_xlsx_test: PASS');
