/**
 * H01 身分推導：救生員必須推得出來，人工指派的角色必須保得住。
 *
 * 修的是這件事：admin_staff.role 的推導原本是
 *   isAdmin ? 'admin' : (isCounter ? 'staff' : (isCoach ? 'coach' : 'staff'))
 * 少了 lifeguard 這一支 —— 不是漏寫，是當時 CHECK constraint 根本沒有這個值。
 * 於是正式庫有 51 位在職救生員被記成「行政櫃檯」，而 staff 在後台是有權限的角色。
 *
 * 另一半是寫入規則。原本「只升成 admin，其餘保留本地值」保住了人工指派的
 * manager；改成能寫 lifeguard 之後，必須明確排除 manager，否則同步會把
 * 場館主管默默降成櫃檯 —— 而那種降級沒有人會收到通知。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../server/services/ragicAdmin.js'), 'utf8');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

check('沒有殘留舊式三元（會吃掉救生員）', () => {
  assert.strictEqual(
    (SRC.match(/isCoach \? 'coach' : 'staff'/g) || []).length, 0,
    '舊寫法把救生員吞進 staff 保底值；改了一處沒改另一處的話，'
    + '行為會取決於走的是同步還是 apply 路徑，極難重現');
});

check('推導含 lifeguard，且兩處都改到', () => {
  const n = (SRC.match(/isLifeguard \? 'lifeguard'/g) || []).length;
  assert.strictEqual(n, 2, `只找到 ${n} 處（同步與 apply 各需要一處）`);
});

check('優先序是 admin > 櫃檯 > 教練 > 救生員', () => {
  const m = SRC.match(/const roleVal = isAdmin \? 'admin'[\s\S]{0,200}?;/);
  assert.ok(m, '找不到 roleVal 的推導');
  const body = m[0];
  const iCounter = body.indexOf("isCounter ? 'staff'");
  const iCoach = body.indexOf("isCoach ? 'coach'");
  const iGuard = body.indexOf("isLifeguard ? 'lifeguard'");
  assert.ok(iCounter > 0 && iCoach > iCounter && iGuard > iCoach,
    '順序不對。櫃檯要排在救生員之前 —— 兼任兩者的人實際在做櫃檯的事，'
    + '而櫃檯是這幾個身分裡唯一需要後台權限的');
});

check('保底值仍是 staff（這次不動一般員工）', () => {
  const m = SRC.match(/const roleVal = isAdmin \? 'admin'[\s\S]{0,200}?;/);
  assert.ok(/:\s*'staff';/.test(m[0]),
    '改動保底值會波及 36 位沒有任何旗標的一般員工，不在這次範圍內');
});

check('寫入規則兩處都排除 manager', () => {
  const n = (SRC.match(/WHEN role = 'manager' THEN 'manager'/g) || []).length;
  assert.strictEqual(n, 2,
    `只找到 ${n} 處（同步 apply 與 staging merge 各需要一處）。`
    + '漏掉的那條會把人工指派的場館主管默默降成櫃檯');
});

check('寫入規則兩處都能寫 coach / lifeguard', () => {
  const n = (SRC.match(/IN \('coach', 'lifeguard'\) THEN \$\d+::text/g) || []).length;
  assert.strictEqual(n, 2, `只找到 ${n} 處；少一處的話那條路徑仍修不好救生員`);
});

check('算出 staff 時不覆蓋本地值', () => {
  // staff 同時是「櫃檯」和「認不出身分」的保底值。拿它去蓋本地資料，
  // 會把人工設定默默降級 —— 而降級不會有任何通知。
  const cases = SRC.match(/role = CASE[\s\S]{0,320}?END,/g) || [];
  assert.strictEqual(cases.length, 2, `找到 ${cases.length} 個 role 寫入規則，預期 2`);
  for (const c of cases) {
    assert.ok(!/'staff'/.test(c),
      'role 的寫入規則裡不該出現 staff —— 它是保底值，不是可信的身分判定');
    assert.ok(/ELSE role\s*$|ELSE role\s*\n/.test(c),
      '認不出來的情況必須保留本地值');
  }
});

console.log(failures ? `\n${failures} FAILED` : '\nrole_derive: ALL PASS');
process.exitCode = failures ? 1 : 0;

