/**
 * 救生員登入後拿到的角色必須是 lifeguard，不能落成 staff。
 *
 * 開放救生員使用後台時，最危險的是登入那一行原本寫著
 *   不是 admin 也不是 manager → 一律 'staff'
 * 照那樣開放，52 位在職救生員登入後會直接變成行政櫃檯，拿到客戶資料、
 * 對帳、退款的全部權限，而且畫面上完全看不出來 —— 沒有錯誤、沒有警告。
 *
 * 開放救生員一共要動五個地方，少一個不是登不進來、就是拿到不該有的權限：
 *   1. constants/roles       backoffice: true
 *   2. _effectiveLoginUser   身分解析要有 lifeguard 分支（且排在櫃檯之後）
 *   3. 登入資格 SQL           解除 is_lifeguard = FALSE 的排除
 *   4. loginRole              取最高身分，不要一律落成 staff
 *   5. admin_users 的 CHECK   否則建帳號時違反約束、登入回 500
 * 第 5 個是實測跑登入才發現的：admin_staff 與 admin_users 是兩張表、各有一個
 * CHECK，先前只放寬了前者。靜態檢查看不出來。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const roles = require(path.join(ROOT, 'server/constants/roles'));
const AUTH = read('server/routes/admin/auth.js');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

check('救生員可登入後台，教練不可', () => {
  assert.ok(roles.BACKOFFICE_ROLES.includes('lifeguard'), '救生員要能登入後台');
  assert.ok(!roles.BACKOFFICE_ROLES.includes('coach'),
    '教練走 LIFF，不該能登入後台');
});

check('登入的角色裁決：八種身分組合都算對', () => {
  // 直接呼叫，不比對原始碼字串。原本那兩條是「找得到 role: 'lifeguard' 這行
  // 而且排在 role: 'staff' 之後」—— 換一種寫法（例如改用 highestRole）測試就紅，
  // 但真正算錯的時候它未必抓得到。要釘住的是結果，不是長相。
  const authMod = require(path.join(ROOT, 'server/routes/admin/auth.js'));
  const effective = authMod._effectiveLoginUser;
  assert.strictEqual(typeof effective, 'function',
    'auth.js 沒有匯出 _effectiveLoginUser，下面每一條都驗不到');

  const cases = [
    ['內建管理員：staff 列只是佔位，真正身分在 admin_users',
      { staff_id: 'S1', staff_role: 'staff', role: 'admin' }, 'admin'],
    ['場館主管',
      { staff_id: 'S1', staff_role: 'manager', role: 'manager' }, 'manager'],
    ['純櫃檯',
      { staff_id: 'S1', staff_role: 'staff', role: 'staff', is_counter: true }, 'staff'],
    ['純救生員（admin_staff.role 落在保底值 staff）',
      { staff_id: 'S1', staff_role: 'staff', role: 'staff', is_lifeguard: true }, 'lifeguard'],
    ['櫃檯兼救生員：不可被降級成救生員，否則他隔天打不開對帳單',
      { staff_id: 'S1', staff_role: 'staff', role: 'staff', is_counter: true, is_lifeguard: true },
      'staff'],
    ['純教練：保底值 staff 不算數，必須拒絕登入',
      { staff_id: 'S1', staff_role: 'staff', role: 'staff', is_coach: true }, null],
    ['教練兼救生員（管理員手動指派）—— 舊版讀不到 admin_staff_roles，會拒絕登入',
      { staff_id: 'S1', staff_role: 'coach', role: 'staff', is_coach: true,
        manual_roles: ['coach', 'lifeguard'] }, 'lifeguard'],
    ['沒有 admin_staff 列的內建系統帳號',
      { staff_id: null, role: 'manager' }, 'manager'],
  ];
  const bad = [];
  for (const [label, input, want] of cases) {
    const got = effective(input);
    const role = got ? got.role : null;
    if (role !== want) {
      bad.push(label + ' → 得到 ' + JSON.stringify(role) + '，應為 ' + JSON.stringify(want));
    }
  }
  assert.deepStrictEqual(bad, [], bad.join(' ｜ '));
});

check('登入資格不再排除救生員', () => {
  assert.ok(/OR COALESCE\(s\.is_lifeguard, FALSE\) = TRUE/.test(AUTH),
    '登入查詢沒有放行救生員');
});

check('登入角色取最高身分，不是一律 staff', () => {
  assert.ok(/highestRole\(identities/.test(AUTH),
    '沒有用 highestRole；原本的三元式會把救生員一律變成行政櫃檯');
  assert.ok(!/\?\s*'manager'\s*:\s*'staff'\)/.test(AUTH),
    '舊的「不是 manager 就 staff」還在，救生員會拿到整套櫃檯權限');
});

check('教練身分不會變成後台角色', () => {
  // coach 不在 BACKOFFICE_ROLES，所以就算出現在身分集合裡也應該被濾掉。
  // 這條與上面那組案例的第 6、7 項互補：那裡驗結果，這裡驗「濾掉」這件事
  // 確實是靠共用的 BACKOFFICE_ROLES，而不是某個檔案自己列的清單。
  assert.ok(/BACKOFFICE_ROLE_SET\.has|BACKOFFICE_ROLES\.includes/.test(AUTH),
    '登入裁決沒有用共用的 BACKOFFICE_ROLES 過濾身分');
  const authMod = require(path.join(ROOT, 'server/routes/admin/auth.js'));
  const onlyCoach = authMod._effectiveLoginUser({
    staff_id: 'S1', staff_role: 'coach', role: 'coach',
    is_coach: true, manual_roles: ['coach'],
  });
  assert.strictEqual(onlyCoach, null,
    '只有教練身分的人登入被放行了 —— 教練走 LIFF，不該有後台 session');
});

check('admin_users 的 CHECK 由 bootstrap 維護，且用 BACKOFFICE_ROLES', () => {
  const schema = read('server/bootstrap/coreSchema.js');
  assert.ok(/ensureAdminUserRoleCheck/.test(schema),
    '沒有維護 admin_users 的 CHECK —— 救生員登入時會建不出帳號（500）');
  const m = schema.match(/async function ensureAdminUserRoleCheck[\s\S]*?\n}/);
  assert.ok(/BACKOFFICE_ROLES/.test(m[0]),
    'admin_users 存的是登入帳號，該用 BACKOFFICE_ROLES 而不是 ASSIGNABLE_ROLES');
});

check('手動身分表不做初始灌入', () => {
  const schema = read('server/bootstrap/coreSchema.js');
  const m = schema.match(/async function ensureStaffManualRoles[\s\S]*?\n}/);
  assert.ok(m, '找不到 ensureStaffManualRoles');
  assert.ok(!/INSERT INTO admin_staff_roles/.test(m[0]),
    '灌入「現有的 role」會把推導值變成永久的手動指派：'
    + '某人的 role 曾是保底值 staff，救生員身分修正後那筆仍留著，'
    + '權限聯集又把整套櫃檯權限加回去 —— 而畫面上完全看不出來');
});

console.log(failures ? `\n${failures} FAILED` : '\nlifeguard_login: ALL PASS');
process.exitCode = failures ? 1 : 0;

