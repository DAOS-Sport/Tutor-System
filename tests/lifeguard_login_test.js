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

check('身分解析有 lifeguard 分支，且排在櫃檯之後', () => {
  const m = AUTH.match(/function _effectiveLoginUser[\s\S]*?\n}/);
  assert.ok(m, '找不到 _effectiveLoginUser');
  const b = m[0];
  const iCounter = b.indexOf("role: 'staff'");
  const iGuard = b.indexOf("role: 'lifeguard'");
  assert.ok(iGuard > 0, '缺少 lifeguard 分支，救生員會被拒絕登入');
  assert.ok(iCounter < iGuard,
    '救生員排在櫃檯之前，會把「櫃檯兼救生員」降級 —— 他隔天就打不開對帳單');
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

check('identities 不含教練（教練沒有後台角色可拿）', () => {
  const m = AUTH.match(/const identities = \[[\s\S]{0,300}?const loginRole/);
  assert.ok(m, '找不到 identities 的組裝');
  assert.ok(!/is_coach/.test(m[0]),
    '把 is_coach 放進來沒有意義：coach 不在 BACKOFFICE_ROLES，只會被濾掉');
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

