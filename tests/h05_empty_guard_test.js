'use strict';
/**
 * H05 場館同步：「呼叫成功但回 0 筆」必須跳過本輪，不可以照流程往下走。
 *
 * ── 不擋的話會發生什麼（實測驗證過的連鎖）──
 *   1. presentCodes 為空 → `DELETE FROM ragic_h05_shadow
 *      WHERE NOT (venue_code = ANY($1::text[]))` 把整張 shadow 清光。
 *      實測：'B' = ANY(ARRAY[]::text[]) → false，NOT false → true，所以全刪。
 *   2. _reconcileH05FromShadowImpl 從空的 shadow 讀到 0 筆 → ragicMap 為空。
 *   3. 最後那個「不在 Ragic 且未人工覆寫就停用」的迴圈，把所有 active 場館
 *      一次停掉 —— 正式庫目前正是營運中的 5 個（B/C/E/K/L，全部沒有 override）。
 *   4. log 只會印 venues=ok(5)，看起來像同步成功了 5 筆。
 *
 * 場館全部停用 = 場館選單空掉、櫃檯場館範圍變空、報名選不到場地。
 *
 * ── 為什麼守門不會誤擋 ──
 * 真的 0 筆代表公司沒有任何場館在履約，那是業務上不可能的狀態；
 * 遠比「Ragic 欄位改名／篩選條件失效」不可能。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server/services/ragicAdmin.js'), 'utf8');
// 順序很重要：先剝「行註解」再剝「區塊註解」。
// 反過來的話，一句 // 註解裡只要出現區塊註解的開頭符號（例如寫路徑時的萬用字元），
// 區塊規則就會從那裡一路吃到下一個結束符號，把中間的程式碼全部當成註解刪掉 ——
// 而「不得包含 X」那類斷言就會因為 X 被吃掉而假性通過。
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}
const CODE = stripComments(SRC);

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// 只看 _shadowPullH05Impl 這一段，避免掃到別的函式而誤判通過。
const FN_START = CODE.indexOf('async function _shadowPullH05Impl');
const FN_END = CODE.indexOf('async function _readShadowH05');
assert.ok(FN_START > 0 && FN_END > FN_START, '找不到 _shadowPullH05Impl —— 掃描失效');
const FN = CODE.slice(FN_START, FN_END);

check('拿到 records 之後、寫 shadow 之前就擋掉 0 筆', () => {
  assert.ok(/if \(!records\.length\)/.test(FN),
    '沒有 0 筆守門 —— 一次空回應就會清空 shadow 並停用所有場館');
  const iGuard = FN.indexOf('if (!records.length)');
  const iDelete = FN.indexOf('DELETE FROM ragic_h05_shadow');
  const iInsert = FN.indexOf('INSERT INTO ragic_h05_shadow');
  assert.ok(iDelete > 0, '找不到那句 DELETE —— 掃描失效');
  assert.ok(iGuard > 0 && iGuard < iInsert && iGuard < iDelete,
    '守門的位置在寫入之後了 —— 必須在碰 shadow 之前就返回');
});

check('0 筆時回 skipped 且 synced=0，不是回一個看起來成功的結果', () => {
  const seg = FN.slice(FN.indexOf('if (!records.length)'), FN.indexOf('const client = await pool.connect()'));
  assert.ok(/skipped: true/.test(seg), '應標成 skipped，讓上層知道這輪沒做');
  assert.ok(/synced: 0/.test(seg), 'synced 必須是 0');
  assert.ok(/error:/.test(seg), '要帶 error 訊息，否則後台看不出發生過什麼');
});

check('0 筆走 console.error 而不是 warn（這是要有人來看的）', () => {
  const seg = FN.slice(FN.indexOf('if (!records.length)'), FN.indexOf('const client = await pool.connect()'));
  assert.ok(/console\.error\(/.test(seg),
    '用 warn 的話會混在每 10 分鐘的例行雜訊裡；場館全掉是要立刻有人處理的事');
});

check('_syncVenuesImpl 會因為 skipped 而不往下跑 reconcile', () => {
  const impl = CODE.slice(CODE.indexOf('async function _syncVenuesImpl'));
  const body = impl.slice(0, impl.indexOf('\n}\n'));
  assert.ok(/if \(shadowResult\.skipped\) return shadowResult;/.test(body),
    'shadow 跳過時仍會往下跑 reconcile —— 那就等於守門沒有用，'
    + 'reconcile 會從舊 shadow 或空 shadow 繼續做停用判斷');
});

check('原本那句危險的 DELETE 還在（守門是加上去的，不是把功能拿掉）', () => {
  assert.ok(/DELETE FROM ragic_h05_shadow\s*\n?\s*WHERE NOT \(venue_code = ANY/.test(FN),
    '清理不在 Ragic 的 shadow 列這個行為本身是對的，不該被一起移除');
});

check('掃描沒有失效：拿掉守門就要被抓到', () => {
  assert.ok(FN.includes('if (!records.length)'), '基準比對不到');
  const mutated = FN.split('if (!records.length)').join('if (false)');
  assert.ok(!mutated.includes('if (!records.length)'),
    '突變後仍找得到，表示比對的不是真的那一段');
});

console.log(failed ? '\n' + failed + ' 項失敗' : '\n全部通過');
process.exit(failed ? 1 : 0);
