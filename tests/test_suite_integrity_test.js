/**
 * 測試套件本身的體檢。
 *
 * 這支的由來：manual_deduction_backdate_test 有一條 check 每次都失敗
 * （它指向的元件在 2026-08 搬到 client/shared/，路徑沒跟著改，於是每次 ENOENT），
 * 但那個檔案結尾沒有 process.exitCode，所以程序照樣 exit 0、runner 記成 PASS。
 * 它瞎了一段時間，而沒有任何人知道。
 *
 * 一支假裝在守門的測試，比沒有測試更危險：沒有測試至少大家知道那件事沒人看。
 *
 * 這裡守兩件事，剛好對應那個 bug 的兩半：
 *   1. 自己接住失敗的測試（有 try/catch 計數的那種）必須把失敗反映到離開碼
 *   2. 測試指到的原始碼檔案必須真的存在 —— 檔案搬走而測試沒跟上，
 *      就會變成「每次都失敗，但沒人看得到」
 *
 * 用裸 assert（不自己接住）的測試不在第 1 條範圍內：它們失敗時會直接 throw，
 * Node 自然以非零離開，本來就是對的。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function testFiles() {
  const out = [];
  for (const dir of ['tests', 'tests/release']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.js')) out.push(dir + '/' + name);
    }
  }
  return out;
}

const FILES = testFiles();
const SELF = 'tests/test_suite_integrity_test.js';

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

check('掃描本身有效（找得到夠多測試檔）', () => {
  assert.ok(FILES.length >= 60,
    '只掃到 ' + FILES.length + ' 支測試，路徑可能不對 —— 那會讓下面每一條都假通過');
});

check('自己接住失敗的測試，一定要把失敗反映到離開碼', () => {
  const bad = [];
  for (const rel of FILES) {
    if (rel === SELF) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // 「自己接住失敗」的形狀：catch 區塊裡對某個計數器做 ++
    const catches = /catch\s*\([^)]*\)\s*\{[^}]*\+\+/.test(src);
    if (!catches) continue;   // 裸 assert 的測試會自己 throw，本來就對
    const setsExit = /process\.exitCode\s*=/.test(src) || /process\.exit\(/.test(src);
    if (!setsExit) bad.push(rel);
  }
  assert.deepStrictEqual(bad, [],
    '這些測試會把自己的失敗吞掉：check 失敗只印在 stderr，程序照樣 exit 0，'
    + 'runner 記成 PASS。它們看起來在守門，實際上沒有：\n       ' + bad.join('\n       ')
    + '\n       修法：檔尾加 process.exitCode = failures ? 1 : 0;');
});

check('測試指到的原始碼檔案都還在', () => {
  // 抓 path.join(ROOT, '...') / path.resolve(__dirname, '..', '...') 這類常數路徑。
  // 只看寫死的字串；動態組出來的路徑這裡管不到。
  const bad = [];
  for (const rel of FILES) {
    if (rel === SELF) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const dir = path.dirname(path.join(ROOT, rel));
    for (const m of src.matchAll(/path\.(?:join|resolve)\(\s*(ROOT|__dirname)\s*((?:,\s*'[^']+'\s*)+)\)/g)) {
      const [, base, argsText] = m;
      const parts = [...argsText.matchAll(/'([^']+)'/g)].map((x) => x[1]);
      const target = parts.join('/');
      // 只驗看起來像檔案的（有副檔名）。目錄與 glob 不管。
      if (!/\.(js|jsx|css|json|md|sql)$/.test(target)) continue;
      // 基準要跟著原始碼寫的走：ROOT 是專案根，__dirname 是那支測試自己的目錄。
      // 一律用 ROOT 去接的話，寫 '../server/x.js' 的那些會被算成 ROOT/../server/x.js
      // 而全部誤報 —— 我第一版就是這樣，19 個全是假陽性。
      const abs = path.resolve(base === 'ROOT' ? ROOT : dir, target);
      if (!fs.existsSync(abs)) bad.push(rel + ' → ' + target);
    }
  }
  assert.deepStrictEqual(bad, [],
    '這些測試指向的檔案不存在。若該測試又沒把失敗反映到離開碼，'
    + '結果就是「每次都失敗，但沒人看得到」：\n       ' + bad.join('\n       '));
});

check('每一支測試都要有結尾的總結輸出', () => {
  // 只印 ok 不印總結的話，跑完一屏綠字，看不出到底有沒有東西紅。
  const bad = [];
  for (const rel of FILES) {
    if (rel === SELF) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const catches = /catch\s*\([^)]*\)\s*\{[^}]*\+\+/.test(src);
    if (!catches) continue;
    // 中英文兩種都要認：這個 repo 兩種寫法都有（'ALL PASS' 與 '全部通過'）。
    // 只認英文的話會把中文那幾支誤報成沒有總結 —— 我第一版就是這樣。
    if (!/console\.(log|error)\([^)]*(FAILED|PASS|failed|passed|失敗|通過)/i.test(src)) bad.push(rel);
  }
  assert.deepStrictEqual(bad, [],
    '這些測試跑完沒有總結，只能靠人一行一行看有沒有 FAIL：\n       ' + bad.join('\n       '));
});

console.log(failures ? '\n' + failures + ' FAILED' : '\ntest_suite_integrity: ALL PASS');
process.exitCode = failures ? 1 : 0;
