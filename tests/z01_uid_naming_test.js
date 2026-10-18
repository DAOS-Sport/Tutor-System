/**
 * Z01 查詢必須用 EID 格式，否則讀不到自己寫進去的 LINE UID。
 *
 * 2026-08-26 診斷：正式站 log 長期出現
 *   「[parent-refresh] Z01 LINE UID 尚未回寫，以本地 UID 續行同步」
 * 而實測 479/479 筆其實都寫好了、且與本地完全一致。系統只是讀不到。
 *
 * 成因是取資料的格式與讀資料的方式對不上：
 *   Ragic API 不帶該參數 → 回應 key 是中文欄位名
 *   getTrueRagicLineUid  → 只讀數字欄位 ID（record[1006846]）
 * 於是每一次都拿到 undefined，靜默變成空字串。
 *
 * 讀取器只認數字 ID 是刻意的（中文欄位名可被改名或重複，數字 ID 不會），
 * 那個設計要保留。錯的是查詢端沒有要求對應的格式。
 *
 * 代價不只是 log 吵：所有依賴 mapped.line_uid 的判斷都失效，
 * 包含「這支電話已綁到別的 LINE」的衝突檢查 —— 它從上線起沒擋過任何一次。
 *
 * 兩個方向一起盯，缺一不可：
 *   1. 兩支查詢函式的 query() 參數裡要有該格式設定
 *   2. 讀取器不可以改成 fallback 中文 key（那是繞過問題，不是修好）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

const ragicSrc = fs.readFileSync(path.join(ROOT, 'server/services/ragic.js'), 'utf8');
const schemaSrc = fs.readFileSync(path.join(ROOT, 'server/config/ragicSchema.js'), 'utf8');

// 註解一定要先剝掉。第一版沒剝，而修正的註解裡剛好也寫了同樣的字串 ——
// 於是把程式碼裡那一行刪掉，測試仍然是綠的。mutation 驗證當場抓到這個套套邏輯。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function bodyOf(src, name) {
  const i = src.indexOf('async function ' + name);
  assert.ok(i >= 0, '找不到 ' + name);
  const j = src.indexOf('\n}', i);
  assert.ok(j > i, name + ' 找不到結尾');
  return stripComments(src.slice(i, j));
}

const NAMING_RE = /naming:\s*'EID'/;

for (const fn of ['getParentByPhone', 'getParentByLineUid', 'getParentRecordByRagicId']) {
  check(fn + ' 的 query() 參數帶 EID 格式', () => {
    const body = bodyOf(ragicSrc, fn);
    const k = body.indexOf('query(');
    assert.ok(k >= 0, fn + ' 裡找不到 query() 呼叫');
    assert.ok(NAMING_RE.test(body.slice(k)),
      '少了它，回應是中文 key，getTrueRagicLineUid 永遠讀到 undefined —— '
      + '「UID 尚未回寫」的假警告與失效的衝突檢查都由此而來');
  });
}

check('getTrueRagicLineUid 仍然只讀數字欄位 ID', () => {
  const i = schemaSrc.indexOf('function getTrueRagicLineUid');
  assert.ok(i >= 0, '找不到 getTrueRagicLineUid');
  const body = stripComments(schemaSrc.slice(i, schemaSrc.indexOf('\n}', i)));
  assert.ok(/RAGIC_Z01_FIELDS\.PARENT_SYSTEM_LINE_UID/.test(body),
    '應該以數字欄位 ID 讀取');
  assert.ok(!/uid'\]/.test(body) && !body.includes('家教系統'),
    '不可以 fallback 中文欄位名 —— 中文名可被改名或重複，schema drift 時會讀到錯的欄位。'
    + '要修的是查詢格式，不是放寬讀取器');
});

console.log(failures ? `\n${failures} FAILED` : '\nz01_uid_naming: ALL PASS');
process.exitCode = failures ? 1 : 0;

