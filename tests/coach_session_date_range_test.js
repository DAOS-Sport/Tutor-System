'use strict';
/**
 * 教練端課表／記錄的日期範圍條件 —— 結構鎖（不連 DB）。
 *
 * 起因：多位教練回報「今天上完課也簽到了，授課記錄裡找不到」。
 * 原因是 server/routes/sessions.js 的 history SQL 有一條
 *   (scheduled_at AT TIME ZONE 'Asia/Taipei')::date < (NOW() AT TIME ZONE 'Asia/Taipei')::date
 * ——「今天」被硬性排除，而日期選擇器的預設結束日就是今天，畫面等於明示今天有包含。
 *
 * 這支測試鎖的是「SQL 長什麼樣」；實際語意由 coach_session_date_range_db_test.js
 * 對真的 Postgres 求值。兩支都要有：只有結構鎖會漏掉語意錯誤，只有 DB 測試
 * 則在沒有測試庫的環境完全不跑。
 */
const assert = require('assert');
const path = require('path');
const sql = require(path.join(__dirname, '..', 'server/utils/sessionDateSql'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

const COL = 'cs.scheduled_at';
const TPE = "AT TIME ZONE 'Asia/Taipei'";

// 把 SQL 裡出現 COL 的每一處，檢查是否都被台北時區轉換包住。
// 用「出現次數相等」而不是「找得到一個」——後者只要有一處正確就會過。
function everyColumnIsTaipeiNormalized(s, col) {
  const colCount = (s.match(new RegExp(col.replace('.', '\\.'), 'g')) || []).length;
  const wrapped = (s.match(new RegExp('\\(?' + col.replace('.', '\\.') + '\\)?\\s*' + TPE.replace(/'/g, "'"), 'g')) || []).length;
  return { colCount, wrapped };
}

console.log('coach_session_date_range_test');

check('historyRangeWhere：與「今天」的比較必須是 <=，不能是 <', () => {
  const s = sql.historyRangeWhere(COL, '$2', '$3');
  assert.ok(s.includes('NOW()'), '掃描失效：產生的 SQL 裡沒有 NOW()');
  // 找出與 NOW() 相關的那個比較運算子
  const m = s.match(/([<>]=?)\s*\(*\(NOW\(\)\)?/);
  assert.ok(m, '找不到與 NOW() 的比較 —— 掃描失效，非真的通過');
  assert.strictEqual(m[1], '<=',
    '與今天的比較是 ' + m[1] + '。用 < 會把「今天」整天排除，'
    + '教練當天上完課、簽了到，記錄頁仍查不到 —— 這正是多位教練回報的問題。');
});

check('historyRangeWhere：每一處欄位都經台北時區轉換', () => {
  const s = sql.historyRangeWhere(COL, '$2', '$3');
  const { colCount, wrapped } = everyColumnIsTaipeiNormalized(s, COL);
  assert.ok(colCount >= 3, '欄位只出現 ' + colCount + ' 次 —— 掃描失效，非真的通過');
  assert.strictEqual(wrapped, colCount,
    colCount + ' 處欄位中只有 ' + wrapped + ' 處做了台北時區轉換。'
    + '裸的 timestamptz 比較會依連線的 TimeZone 設定而變。');
});

check('weekRangeWhere：每一處欄位都經台北時區轉換（不可依賴連線 TimeZone）', () => {
  const s = sql.weekRangeWhere(COL, '$2', '$3');
  const { colCount, wrapped } = everyColumnIsTaipeiNormalized(s, COL);
  assert.ok(colCount >= 2, '欄位只出現 ' + colCount + ' 次 —— 掃描失效，非真的通過');
  assert.strictEqual(wrapped, colCount,
    '週課表原本寫 `cs.scheduled_at >= $2`，直接拿 timestamptz 比對日期字串。'
    + '正式庫的 TimeZone 剛好是 Asia/Taipei 所以目前正確，但那是巧合不是保證：'
    + '任何環境沒設對就整週偏 8 小時。');
});

check('todayWhere：今日課程也走同一套台北日曆日判準', () => {
  const s = sql.todayWhere(COL);
  const { colCount, wrapped } = everyColumnIsTaipeiNormalized(s, COL);
  assert.ok(colCount >= 1, '掃描失效');
  assert.strictEqual(wrapped, colCount, '今日課程的欄位沒有全部做台北時區轉換');
  assert.ok(s.includes('NOW()'), '應以 NOW() 的台北日期為準');
});

check('參數佔位符照傳入的用，不會寫死', () => {
  const a = sql.historyRangeWhere(COL, '$7', '$8');
  assert.ok(a.includes('$7') && a.includes('$8'), '沒有使用傳入的參數編號');
  assert.ok(!a.includes('$2') && !a.includes('$3'), '寫死了 $2/$3，換到別支 SQL 會對錯參數');
});

if (failures) {
  console.error('\ncoach_session_date_range_test: ' + failures + ' failed');
  process.exit(1);
}
console.log('coach_session_date_range_test: all passed');
