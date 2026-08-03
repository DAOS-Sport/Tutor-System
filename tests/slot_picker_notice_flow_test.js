'use strict';
/**
 * 首次預約提示流程的結構迴歸檢查。
 *
 * 為什麼是「讀原始碼」而不是真的跑起來：這是純 UI 流程，repo 裡沒有 DOM
 * 測試環境，架一套 jsdom + testing-library 只為了這一條流程不划算。
 * 這支測試的能力邊界要講清楚——它證明的是「程式碼結構上，確認提示之後
 * 會走到送出預約」，不能證明畫面真的按得動。真機驗證仍然必要。
 *
 * 它擋的是這個實際發生過的 bug：
 *   ackNotice() 只呼叫 ack API 然後關掉彈窗，submit() 早就 return 了，
 *   於是按鈕寫著「我已確認，繼續預約」卻從來沒有呼叫 slotsApi.book()。
 *   每個課期的第一次預約都靜默失敗，沒有成功也沒有失敗提示。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'client', 'liff', 'src', 'components', 'SlotPicker.jsx');
const src = fs.readFileSync(FILE, 'utf8');

/** 取出某個 async function 的函式體（以大括號配對掃描，避免正則吃錯範圍）。 */
function bodyOf(name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notStrictEqual(start, -1, `找不到 ${name}()`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name}() 的大括號不配對`);
}

const ack = bodyOf('ackNotice');
const doBook = bodyOf('doBook');
const submit = bodyOf('submit');

// ① 確認提示之後必須真的送出預約
assert.ok(/\bdoBook\s*\(/.test(ack),
  'ackNotice() 必須在 ack 成功後接續送出預約——按鈕文案承諾「繼續預約」，' +
  '只關彈窗會讓每個課期的第一次預約靜默失敗');

// ② 送出預約的唯一實作處
assert.ok(/slotsApi\.book\s*\(/.test(doBook), 'doBook() 必須呼叫 slotsApi.book()');
assert.ok(!/slotsApi\.book\s*\(/.test(ack), 'ackNotice() 不該自己重寫一份預約邏輯，應共用 doBook()');
assert.ok(!/slotsApi\.book\s*\(/.test(submit), 'submit() 不該自己重寫一份預約邏輯，應共用 doBook()');

// ③ ack 失敗時不得預約（fail-closed）：catch 區塊裡要提早 return
{
  const m = ack.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{4}\}/);
  assert.ok(m, 'ackNotice() 應有 catch 區塊');
  assert.ok(/\breturn\b/.test(m[1]),
    'ack 失敗時必須提早 return，否則會在「未確認」的狀態下把課預約掉');
}

// ④ 提示彈窗的確認按鈕要接到 ackNotice，而不是直接接到預約
assert.ok(/onConfirm=\{ackNotice\}/.test(src), '提示彈窗的 onConfirm 應為 ackNotice');

// ⑤ 兩條路徑都要收掉提示彈窗，否則預約成功後彈窗還留在畫面上
assert.ok(/setNoticeOpen\(false\)/.test(doBook),
  'doBook() 的成功與失敗路徑都要關掉提示彈窗');

// ⑥ 觸發條件必須是嚴格布林。後端對教練手建的槽位回 null，
//    用 !== false 會把手建槽位也攔下來（這個 bug 也真的發生過）。
assert.ok(/is_auto\s*===\s*true/.test(submit),
  'is_auto 必須用嚴格 === true 判斷');
assert.ok(!/is_auto\s*!==\s*false/.test(src), '不得用 is_auto !== false');

console.log('slot_picker_notice_flow_test: PASS');