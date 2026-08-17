/**
 * 共用日期選擇器全站導用（2026-08-17 owner「可以都換」）
 *
 * 三件會靜默壞掉、而且壞了不會有人發現的事：
 *   1. Tailwind 的 content glob 沒含 ../shared → 共用元件的 class 全被清掉，
 *      建置不報錯、畫面直接裸奔
 *   2. 相對路徑寫錯層數 → 建置會擋下來，但改目錄時很容易漏掉
 *   3. 有人新增頁面時又用回原生 <input type="date">，風格慢慢分岔回去
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
function stripComments(src) {
  return src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (n === 'node_modules' || n === 'dist') continue;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
}

const SHARED = path.join(ROOT, 'client/shared/DateTimePicker.jsx');

check('Tailwind 兩個 config 都要掃 client/shared', () => {
  // ⚠️ 這裡不能用 stripComments：glob 字串 './src/**/*.{js,jsx}' 裡的 /**/ 
  // 剛好是合法的區塊註解，會被整段吃掉，然後這條測試就變成無聲的假紅／假綠。
  // 只剝行註解就夠了。
  const stripLineComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');
  for (const app of ['liff', 'admin']) {
    const cfg = fs.readFileSync(path.join(ROOT, 'client', app, 'tailwind.config.js'), 'utf8');
    const m = /content:\s*\[([^\]]*)\]/.exec(stripLineComments(cfg));
    assert.ok(m, app + ' 的 tailwind.config.js 找不到 content —— 掃描已失效');
    assert.ok(/\.\.\/shared\/\*\*/.test(m[1]),
      app + ' 的 content glob 沒有含 ../shared/** —— 共用元件的 Tailwind class 會被'
      + '整批清掉。建置不會報錯，畫面會直接裸奔（無邊框、無間距、無顏色）。');
  }
});

check('共用選擇器的 import 路徑層數正確', () => {
  const files = [...walk(path.join(ROOT, 'client/liff/src')), ...walk(path.join(ROOT, 'client/admin/src'))];
  const users = files.filter((f) => fs.readFileSync(f, 'utf8').includes('shared/DateTimePicker'));
  assert.ok(users.length >= 10, '只有 ' + users.length + ' 個檔案引用 —— 掃描可能失效');
  for (const f of users) {
    const m = /from '((?:\.\.\/)+shared\/DateTimePicker\.jsx)'/.exec(fs.readFileSync(f, 'utf8'));
    assert.ok(m, path.relative(ROOT, f) + ' 的 import 不是預期格式');
    const resolved = path.resolve(path.dirname(f), m[1]);
    assert.strictEqual(resolved, SHARED,
      path.relative(ROOT, f) + ' 的相對路徑指到 ' + path.relative(ROOT, resolved) + '，層數算錯');
  }
});

check('不得再有原生 date / datetime-local 輸入框', () => {
  const files = [...walk(path.join(ROOT, 'client/liff/src')), ...walk(path.join(ROOT, 'client/admin/src'))];
  assert.ok(files.length > 40, '只掃到 ' + files.length + ' 個 jsx —— 掃描已失效');
  const offenders = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    // 白名單式：抓 <input ... type=（含三元運算），再看解析出來的字面值。
    for (const m of src.matchAll(/type=\{?['"]?([^'"}\s]*)/g)) {
      if (['date', 'datetime-local', 'time'].includes(m[1])) {
        // Filter / Inp 這類包裝器是用 type="date" 當「語意 prop」再往內分流，
        // 只有真的長在 <input 上才算。
        const before = src.slice(Math.max(0, m.index - 120), m.index);
        if (/<input[^>]*$/.test(before)) offenders.push(path.relative(ROOT, f) + ' → ' + m[1]);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    '仍有原生日期輸入框：\n         ' + offenders.join('\n         ')
    + '\n       改用 client/shared/DateTimePicker.jsx（mode="date|datetime|time"）');
});

check('共用元件：min/max 都要擋，且日期運算釘 UTC', () => {
  const src = stripComments(fs.readFileSync(SHARED, 'utf8'));
  assert.ok(/grid-cols-7/.test(src), '掃描已失效：找不到日曆網格');

  assert.ok(/const\s+blocked\s*=\s*\(!!maxDay && k > maxDay\)\s*\|\|\s*\(!!minDay && k < minDay\)/.test(src),
    '日期格沒有同時判 min 與 max');
  assert.ok(/disabled=\{blocked\}/.test(src), '超出界線的日期沒有 disabled，仍點得下去');

  // 夾回界線：選到界線當天時，時分可能越界。
  assert.ok(/if \(max && out > max\) out = max;/.test(src), '沒有把越界值夾回 max');
  assert.ok(/if \(min && out < min\) out = min;/.test(src), '沒有把越界值夾回 min');

  assert.ok(/Date\.UTC\(/.test(src), '日期運算沒有釘 UTC');
  assert.ok(/8 \* 3600 \* 1000/.test(src), '「今天」沒有釘台北時區');

  // 表單內的按鈕漏標 type="button" 會在點日期時觸發表單送出。
  const btns = src.match(/<button/g) || [];
  const typed = src.match(/type="button"/g) || [];
  assert.ok(btns.length >= 6, '解析到的 button 只有 ' + btns.length + ' 個 —— 掃描可能失效');
  assert.strictEqual(typed.length, btns.length,
    btns.length + ' 顆 button 只有 ' + typed.length + ' 顆標了 type="button"');

  // 年月快速跳轉：生日欄位要能一次跳到 2015 年，不是按 130 次箭頭。
  assert.ok(/setPickingMonth/.test(src) && /aria-label="年份"/.test(src),
    '缺少年月快速跳轉 —— 生日欄位會比原生 input 難用');
});

check('生日欄位一律擋未來', () => {
  const birth = [
    'client/liff/src/pages/RegisterPage.jsx',
    'client/liff/src/pages/ProfilePage.jsx',
    'client/liff/src/components/group/GroupMemberFields.jsx',
  ];
  for (const rel of birth) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.ok(/birth_date/.test(src), rel + ' 掃描已失效：找不到 birth_date');
    assert.ok(/max=\{todayTaipeiYMD\(\)\}/.test(src),
      rel + ' 的生日欄位沒有 max —— 選得到未來的出生日期');
    assert.ok(/8 \* 3600 \* 1000/.test(src), rel + ' 的「今天」沒有釘台北時區');
  }
});

if (failures) { console.error('\nshared_datepicker_rollout_test: ' + failures + ' failed'); process.exit(1); }
console.log('shared_datepicker_rollout_test: all passed');
