'use strict';
/**
 * 缺 token 的兩種情況，吵的音量必須不同。
 *
 * (A) 四個場館代號缺 token = 設計狀態。那四個場館 OA 屬於另一個 provider，
 *     uid 對不上（2026-08-05 實測 0/60），token 本來就沒設、各館推播開關也是關的。
 *     舊呼叫端直接把 venue_id 丟進 getToken() 是常態，每次噴 ERROR 只會把真問題淹掉。
 *
 * (B) STAFF_CHANNEL（dreams400）或任何非場館代號缺 token = 真故障，
 *     所有推播都會死。必須是 ERROR，而且要給完整診斷（設了哪些、缺哪個、去哪補）。
 *
 * 這支測試存在的理由：把音量降下來很容易順手降過頭，變成「全部都不吵」。
 * 那正是這個 codebase 一路在防的「無聲消失」。所以 (B) 必須有明確的正面斷言。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// getToken 是 module-private，而且「每個 key 只吵一次」的節流是 module-scope 狀態 ——
// 要用執行期攔截測，得反覆清 require.cache 才不會第二個案例整個沒輸出。
// 這裡要鎖的本來就是「哪一段走 error、哪一段走 warn」這個結構決定，
// 所以直接對原始碼斷言，不為了測試去改產品程式碼的匯出面。
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server/services/line.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SRC);

check('缺 token 的分類依據是 VENUE_ENV_ALIAS 白名單，不是字串長相', () => {
  assert.ok(/hasOwnProperty\.call\(VENUE_ENV_ALIAS, String\(venueId\)\)/.test(CODE),
    '沒有用 VENUE_ENV_ALIAS 當白名單分類。用「長度是 1 就當場館代號」這種猜法，'
    + '新場館或打錯的 key 都會被誤判成設計狀態而靜靜消失');
  assert.ok(!/venueId\.length\s*===?\s*1/.test(CODE), '出現以長度猜場館代號的寫法');
});

check('場館代號缺 token → warn，不是 error', () => {
  const m = CODE.match(/if \(byDesign\) \{([\s\S]*?)\} else \{/);
  assert.ok(m, '找不到 byDesign 分支 —— 掃描失效，本測試等於沒在測');
  assert.ok(/console\.warn\(/.test(m[1]), '設計狀態那條應該用 console.warn');
  assert.ok(!/console\.error\(/.test(m[1]), '設計狀態那條仍在用 console.error');
});

check('非場館代號（含 STAFF_CHANNEL）缺 token → error，且保留完整診斷', () => {
  const m = CODE.match(/\} else \{([\s\S]*?)\n      \}\n    \}/);
  assert.ok(m, '找不到 else 分支 —— 掃描失效');
  const branch = m[1];
  assert.ok(/console\.error\(/.test(branch),
    '真故障那條必須是 console.error。降級成 warn 等於讓「所有推播都死了」變成沒人看見');
  for (const needle of ['LINE_MESSAGING_TOKENS', 'LINE_MESSAGING_TOKEN_', 'fromJson', 'fromEnv']) {
    assert.ok(branch.includes(needle),
      `真故障的診斷少了 ${needle} —— 少了它，收到告警的人不知道現在設了什麼、該去哪補`);
  }
});

check('兩種情況共用同一個 throw，而且在 if/else 之後（呼叫端行為不變）', () => {
  // 只改音量、不改控制流。若哪天把設計狀態改成「回 null 不 throw」，
  // 呼叫端會拿著 undefined token 去打 LINE API，錯得更難查。
  const THROW = "throw new Error('No LINE token for venue: ' + venueId);";
  const hits = CODE.split(THROW).length - 1;
  assert.strictEqual(hits, 1,
    `缺 token 的 throw 出現 ${hits} 次，應該剛好 1 次（兩個分支共用）。`
    + '分開寫遲早會有一邊被改掉，變成一種情況 throw、另一種靜靜回 undefined');
  // 位置要在兩個分支「之後」，才代表是共用的，而不是塞在其中一支裡面。
  const iThrow = CODE.indexOf(THROW);
  const iWarn = CODE.indexOf('console.warn(\n          \'[line] 場館 ');
  const iErrBranch = CODE.indexOf('沒有 Messaging API token');
  assert.ok(iErrBranch > 0, '找不到真故障分支的訊息 —— 掃描失效');
  assert.ok(iThrow > iErrBranch,
    'throw 跑到分支裡面了 —— 設計狀態那條會走不到 throw，呼叫端拿到 undefined token');
  assert.ok(iWarn === -1 || iThrow > iWarn, 'throw 應在 warn 之後');
});

check('每個 key 只吵一次的節流沒被拆掉', () => {
  assert.ok(/_warnedMissingToken\.has\(venueId\)/.test(CODE) && /_warnedMissingToken\.add\(venueId\)/.test(CODE),
    '節流不見了 —— cron 迴圈裡每個收件人都會刷一行，真問題會被淹掉');
});

check('掃描沒有失效：把 warn 改回 error 就要被抓到', () => {
  const mutated = CODE.replace(/if \(byDesign\) \{([\s\S]*?)console\.warn\(/, 'if (byDesign) {$1console.error(');
  const m = mutated.match(/if \(byDesign\) \{([\s\S]*?)\} else \{/);
  assert.ok(m && /console\.error\(/.test(m[1]),
    '突變後仍抓不到 console.error，表示上面那條斷言比對的不是真的那一段');
});

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
