/**
 * 手動扣課「押上課時間」（2026-08-17 owner 要求）
 *
 * 櫃台可以回填過去時間補扣。要守住的三件事：
 *   1. 未來時間一定要擋 —— 放行會生出「日期在未來、狀態卻是 completed」的課堂
 *   2. 只有回填的上課／簽到時間會變，稽核時間必須永遠是操作當下
 *   3. request_id 的快取鍵必須跟著原因與時間變 —— 否則舊鍵配新內容會被後端
 *      擋成 409 IDEMPOTENCY_CONFLICT，而櫃台完全看不懂那個錯誤
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// 先剝行註解、再剝區塊註解。順序顛倒的話，一個含有 "/*" 的 // 註解會讓區塊
// 正則吞掉後面幾十行程式，讓「不得包含 X」的斷言無聲通過。此專案踩過。
function stripComments(src) {
  return src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const SERVER = path.join(ROOT, 'server/routes/admin/manualDeductions.js');
const PAGE = path.join(ROOT, 'client/admin/src/pages/ManualDeductionPage.jsx');
const PICKER = path.join(ROOT, 'client/admin/src/components/DateTimePicker.jsx');

check('後端：未來的 occurred_at 必須被擋，且在開 transaction 之前', () => {
  const src = stripComments(fs.readFileSync(SERVER, 'utf8'));
  assert.ok(/INSERT INTO manual_lesson_deductions/.test(src), '掃描已失效：找不到 ledger INSERT');

  const guard = src.indexOf('OCCURRED_AT_FUTURE');
  assert.ok(guard > 0, '找不到未來時間守門（OCCURRED_AT_FUTURE）');

  const connect = src.indexOf('await pool.connect()');
  assert.ok(connect > 0, '掃描已失效：找不到 pool.connect()');
  assert.ok(guard < connect,
    '未來時間的守門在開連線之後才跑 —— 應該在任何 DB 動作之前就 400 回去');

  // 必須被 body.occurred_at 護住：沒填時間走的是「伺服器當下」，
  // 那條路徑不該因為機器時鐘快幾秒就被自己的守門擋掉。
  const line = src.split('\n').find((l) => l.includes('OCCURRED_AT_FUTURE'));
  const block = src.slice(Math.max(0, guard - 400), guard);
  assert.ok(/if\s*\(\s*body\.occurred_at\s*&&/.test(block),
    '守門沒有用 body.occurred_at 護住，未指定時間的預設路徑也會被誤擋');
  assert.ok(line.includes('400') || /status\(400\)/.test(block), '未來時間應回 400');
});

check('後端：稽核時間不得被回填（completed_at / created_at 一律 NOW）', () => {
  const src = stripComments(fs.readFileSync(SERVER, 'utf8'));

  // course_sessions 的 completed_at 必須是 NOW()，不是 occurredAt。
  const sessionInsert = src.slice(src.indexOf('INSERT INTO course_sessions'));
  const values = sessionInsert.slice(0, 400);
  assert.ok(/completed_at/.test(values), '掃描已失效：course_sessions INSERT 沒有 completed_at 欄位');
  assert.ok(/'completed',\s*NOW\(\)/.test(values),
    'completed_at 不是 NOW() —— 稽核時間被回填了，就查不出這筆是何時補登的');

  // ledger 的欄位清單裡不得出現 created_at（交給資料庫預設值 = 寫入當下）。
  const ledger = src.slice(src.indexOf('INSERT INTO manual_lesson_deductions'));
  const cols = ledger.slice(0, ledger.indexOf('VALUES'));
  assert.ok(cols.includes('remaining_before'), '掃描已失效：ledger 欄位清單抓錯');
  assert.ok(!/\bcreated_at\b/.test(cols),
    'ledger 明寫了 created_at —— 補扣時間會蓋掉「實際何時操作」這個唯一的事實來源');

  // 回填的那兩個欄位反過來必須真的吃 occurredAt，否則這個功能等於沒做。
  assert.ok(/scheduled_at[\s\S]{0,400}occurredAt\.toISOString\(\)/.test(src),
    'course_sessions.scheduled_at 沒有吃 occurredAt');
  assert.ok(/checkin_records[\s\S]{0,600}occurredAt\.toISOString\(\)/.test(src),
    'checkin_records.checked_in_at 沒有吃 occurredAt');
});

check('前端：request_id 快取鍵含原因與時間（避免 409 IDEMPOTENCY_CONFLICT）', () => {
  const src = stripComments(fs.readFileSync(PAGE, 'utf8'));
  assert.ok(/manualDeductionsApi\.create/.test(src), '掃描已失效：找不到 create 呼叫');

  const m = src.match(/const\s+reqKey\s*=\s*`([^`]+)`/);
  assert.ok(m, '找不到 reqKey —— request_id 若仍只用 (課期,學員) 當鍵，改原因或時間重送會 409');
  const tpl = m[1];
  // 後端 payloadFingerprint 吃的就是這三樣（course_period_id/student_id 在 key 裡）。
  for (const part of ['${key}', '${trimmedReason}', '${occurredIso']) {
    assert.ok(tpl.includes(part), 'reqKey 少了 ' + part + '，該欄位一改就會撞冪等衝突');
  }
  assert.ok(/requestIdsRef\.current\.(get|set)\(reqKey/.test(src),
    'reqKey 算出來卻沒拿去存取快取');

  // busyKey 必須維持短鍵：JSX 是用 busyKey === key 判斷哪顆按鈕在轉，
  // 換成長鍵會讓「正在扣除…」永遠不顯示。
  assert.ok(/setBusyKey\(key\)/.test(src), 'busyKey 應維持 (課期:學員) 短鍵');
});

check('前端：未來時間在送出前就擋掉，且選擇器有 max', () => {
  const src = stripComments(fs.readFileSync(PAGE, 'utf8'));
  assert.ok(/<DateTimePicker/.test(src), '掃描已失效：找不到時間選擇器');
  assert.ok(/max=\{toTaipeiDateTimeInput\(new Date\(\)\)\}/.test(src),
    '選擇器沒有 max，日期面板選得到未來');
  assert.ok(/不能填未來時間/.test(src), '送出前沒有未來時間的檢查');
  // 容許一分鐘：datetime-local 只到分，選在「現在這一分」不該被當成未來。
  assert.ok(/Date\.now\(\)\s*\+\s*60000/.test(src),
    '沒有分鐘級容差 —— 選當下這一分會被自己的檢查誤擋');
  // 畫面預覽與實際送出必須走同一支解析，否則橫幅說的時間可能不是送出的時間。
  const uses = src.match(/parseOccurred\(/g) || [];
  assert.ok(uses.length >= 3,
    'parseOccurred 只出現 ' + uses.length + ' 次 —— 預覽與送出應共用同一支解析');
});

check('前端：欄位預填當下，但沒動過就不得送 occurred_at', () => {
  const src = stripComments(fs.readFileSync(PAGE, 'utf8'));
  assert.ok(/manualDeductionsApi\.create/.test(src), '掃描已失效：找不到 create 呼叫');

  // 預填：進來就看得到當下時間（owner 2026-08-17 要求）。
  assert.ok(/useState\(\(\)\s*=>\s*toTaipeiDateTimeInput\(new Date\(\)\)\)/.test(src),
    '上課時間欄位沒有預填當下時間');

  // 但沒動過時送出的 occurred_at 必須是 null。永遠帶著預填值的話，
  // 扣課逾時後隔一分鐘重試，預填時間已跳掉 → fingerprint 變 → request_id 換一組
  // → 那次重試不再冪等，可能真的扣兩堂。
  assert.ok(/occurredTouched/.test(src), '找不到「有沒有動過」的旗標');
  assert.ok(/const\s+occurredIso\s*=\s*occurredTouched\s*\?\s*pickedIso\s*:\s*null/.test(src),
    '沒動過時仍會送出指定時間 —— 逾時重試會失去冪等性');

  // 旗標只能由使用者輸入翻起來，不能被別處偷偷設成 true。
  const setTrue = src.match(/setOccurredTouched\(true\)/g) || [];
  assert.strictEqual(setTrue.length, 1,
    'setOccurredTouched(true) 出現 ' + setTrue.length + ' 次 —— 只該由輸入框的 onChange 觸發');
  assert.ok(/onChange=\{\(v\) => \{ setOccurredTouched\(true\)/.test(src),
    'touched 不是由選擇器的 onChange 設定的');

  // 突變驗證：拿掉條件改成永遠送，斷言必須擋下來。
  const mutated = src.replace(/const\s+occurredIso\s*=\s*occurredTouched\s*\?\s*pickedIso\s*:\s*null/, 'const occurredIso = pickedIso');
  assert.ok(!/const\s+occurredIso\s*=\s*occurredTouched\s*\?\s*pickedIso\s*:\s*null/.test(mutated),
    '突變沒有生效 —— 本測試的偵測邏輯無效');
});

check('選擇器：未來日期不可點，且不吃瀏覽器本機時區', () => {
  const src = stripComments(fs.readFileSync(PICKER, 'utf8'));
  assert.ok(/grid-cols-7/.test(src), '掃描已失效：找不到日曆網格');

  // max 之後的日子必須是 disabled，不是只有變灰 —— 只變灰照樣點得下去。
  assert.ok(/const\s+blocked\s*=\s*!!maxDay\s*&&\s*k\s*>\s*maxDay/.test(src),
    '找不到「超過 max 的日期」判定');
  assert.ok(/disabled=\{blocked\}/.test(src), '未來日期沒有 disabled，仍然點得下去');

  // 選到 max 當天時，時與分也要跟著封上限，否則今天可以選到晚上的時間。
  assert.ok(/hourMax/.test(src) && /minuteMax/.test(src), '缺少時分的上限');
  assert.ok(/disabled=\{h > hourMax\}/.test(src), '小時沒有封上限');
  assert.ok(/disabled=\{m > minuteMax\}/.test(src), '分鐘沒有封上限');

  // 月曆的星期／月份天數一律走 UTC。用本地時區的 Date 會在 UTC+8 的月底差一天。
  assert.ok(/Date\.UTC\(/.test(src), '日期運算沒有釘 UTC');
  assert.ok(!/getFullYear\(\)\s*,\s*.*getMonth\(\)/.test(src), '疑似用本地時區做日期運算');

  // 表單內的按鈕一律 type="button"：漏一個就會在點日期時送出查詢表單。
  const btns = src.match(/<button/g) || [];
  const typed = src.match(/type="button"/g) || [];
  assert.ok(btns.length >= 4, '解析到的 button 只有 ' + btns.length + ' 個 —— 掃描可能失效');
  assert.strictEqual(typed.length, btns.length,
    btns.length + ' 顆 button 只有 ' + typed.length + ' 顆標了 type="button"，'
    + '漏標的那顆會在表單內觸發送出');
});

check('前端：時區固定台北，不吃瀏覽器本機時區', () => {
  const src = stripComments(fs.readFileSync(PAGE, 'utf8'));
  assert.ok(/taipeiInputToDate\(/.test(src),
    '沒有用 taipeiInputToDate —— 直接 new Date(datetime-local) 會依櫃台電腦的時區解讀');
  assert.ok(!/new Date\(\s*occurredAt\s*\)/.test(src),
    '有直接 new Date(occurredAt)：櫃台電腦時區設錯，寫進資料庫的時間就整段偏移');
});
