/**
 * /api/courses/base-price 一定要帶場館 —— 而且是「每一個呼叫端」都要帶。
 *
 * 2026-08-26 正式站事故：分區之後這支端點改成強制要求 venue（正確：不指名場館
 * 就可能拿到別區的價格），但只有 CoachListPage 被更新，useEnrollmentBoot 漏了。
 * 後果是 /enroll 整頁對所有家長回「資料載入失敗」—— 報名流程全斷。
 *
 * 當時的註解甚至寫著「呼叫端（CoachListPage）本來就已經選好場館了」，
 * 也就是只檢查了一個呼叫端就下結論。這個測試把「所有呼叫端」變成機器來數。
 *
 * 兩邊都盯：
 *   1. 後端仍然強制要求 venue —— 不可以為了修這個 bug 反過來放寬後端，
 *      那會讓「靜默拿到別區價格」這個更難發現的問題回來
 *   2. 前端每一個 basePrice() 呼叫都帶第二個參數
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

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

check('後端仍然強制要求 venue', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/routes/courses.js'), 'utf8');
  const i = src.indexOf("router.get('/base-price'");
  assert.ok(i >= 0, '找不到 base-price 端點');
  const body = src.slice(i, i + 1200);
  assert.ok(/VENUE_REQUIRED/.test(body),
    '後端不再要求 venue —— 這樣「不指名場館」就會靜默拿到某一區的價格，'
    + '那比整頁報錯難發現得多，不可以用放寬後端的方式修這個 bug');
});

check('每一個 basePrice() 呼叫都有帶場館', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'client'))) {
    // api/courses.js 是定義處，不是呼叫端
    if (file.endsWith(path.join('api', 'courses.js'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    const re = /basePrice\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(src))) {
      const args = m[1].split(',').map((a) => a.trim()).filter(Boolean);
      if (args.length < 2) {
        offenders.push(path.relative(ROOT, file) + ' → basePrice(' + m[1] + ')');
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    '這些呼叫沒有帶場館，會讓該頁面直接 400 VENUE_REQUIRED： ' + offenders.join(' ; '));
});

check('報名頁的 boot 確實把 venueId 傳下去', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'client/liff/src/hooks/useEnrollmentBoot.js'), 'utf8');
  assert.ok(/basePrice\(courseType,\s*venueId\)/.test(src),
    'useEnrollmentBoot 是 /enroll 唯一的資料來源，漏帶就是整個報名流程斷掉');
});

check('boot 失敗時顯示伺服器給的原因，而不是一律「資料載入失敗」', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'client/liff/src/hooks/useEnrollmentBoot.js'), 'utf8');
  assert.ok(/err\?\.response\?\.data\?\.error/.test(src),
    '三個請求併發，塌成同一句話會讓人看不出是教練、場館還是價格出問題');
});

console.log(failures ? `\n${failures} FAILED` : '\nbase_price_venue: ALL PASS');
process.exitCode = failures ? 1 : 0;

