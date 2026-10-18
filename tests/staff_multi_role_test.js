/**
 * 員工身分可以多選，而且不能寫回 Ragic 的權威欄位。
 *
 * 一個人身兼數職是常態：教練兼救生員 14 位、櫃檯兼救生員、主管兼櫃檯。
 * 原本編輯視窗只能選一個，存下去就把其他身分蓋掉了。
 *
 * 兩件事這裡盯得比較死：
 *   1. 手動指派存在 admin_staff_roles，不是覆蓋 is_counter / is_coach / is_lifeguard。
 *      那三個是 H01 的權威欄位，寫進去下次同步會被蓋回來 —— 而且是無聲的，
 *      管理員會以為存好了。
 *   2. admin_staff.role 仍是單值「代表值」（登入與既有查詢都靠它），
 *      取勾選集合裡優先序最高的那一個，而優先序只有一份定義。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { highestRole, ASSIGNABLE_ROLES } = require(path.join(ROOT, 'server/constants/roles'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

check('highestRole 依陣列順序取最高', () => {
  assert.strictEqual(highestRole(['lifeguard', 'coach', 'staff']), 'staff');
  assert.strictEqual(highestRole(['lifeguard', 'coach']), 'coach');
  assert.strictEqual(highestRole(['lifeguard']), 'lifeguard');
  assert.strictEqual(highestRole(['manager', 'staff']), 'manager');
  assert.strictEqual(highestRole([]), null);
  assert.strictEqual(highestRole(['wizard']), null, '不認得的值不該被當成角色');
});

check('優先序只有一份定義（就是 ASSIGNABLE_ROLES 的順序）', () => {
  assert.deepStrictEqual([...ASSIGNABLE_ROLES],
    ['admin', 'manager', 'staff', 'coach', 'lifeguard'],
    '順序改動會同時改變代表值的推導，不能只改一邊');
  const staffJs = read('server/routes/admin/staff.js');
  assert.ok(/highestRole\(manualRoles\)/.test(staffJs),
    '存檔沒有用共用的 highestRole，會出現「同步算的主要角色」與「手動存的」不一致');
});

check('手動指派存進 admin_staff_roles，不碰 Ragic 的旗標', () => {
  const staffJs = read('server/routes/admin/staff.js');
  assert.ok(/INSERT INTO admin_staff_roles/.test(staffJs), '沒有寫進手動身分表');
  // 直接寫回 Ragic 權威欄位是這裡最該防的錯
  assert.ok(!/UPDATE admin_staff SET[^;]*is_lifeguard\s*=\s*\$/.test(
    staffJs.replace(/is_coach = \$5, is_counter = \$6, is_lifeguard = \$7/g, '')),
    'PATCH 不該寫 is_lifeguard —— 那是 H01 的權威欄位，下次同步會被蓋回來');
});

check('整組取代而不是逐項增刪', () => {
  const staffJs = read('server/routes/admin/staff.js');
  const i = staffJs.indexOf('INSERT INTO admin_staff_roles');
  const before = staffJs.slice(Math.max(0, i - 400), i);
  assert.ok(/DELETE FROM admin_staff_roles WHERE staff_id/.test(before),
    '前端送來的是畫面上的完整勾選狀態；逐項 diff 只會多一種不同步的可能');
});

check('空集合與不合法角色都會被擋', () => {
  const staffJs = read('server/routes/admin/staff.js');
  assert.ok(/ROLES_REQUIRED/.test(staffJs), '沒有擋「一個都沒選」');
  assert.ok(/ROLE_INVALID/.test(staffJs), '沒有擋不合法的角色值');
});

check('權限判定把手動身分算進聯集', () => {
  const svc = read('server/services/rolePermissions.js');
  assert.ok(/admin_staff_roles/.test(svc),
    '手動指派沒有進入身分聯集，等於存了不生效');
  assert.ok(/for \(const r of row\.manual_roles \|\| \[\]\)/.test(svc),
    '手動身分要逐一加入集合');
});

check('畫面上 Ragic 認定的身分鎖住不可取消', () => {
  const modal = read('client/admin/src/pages/StaffEditModal.jsx');
  assert.ok(/lockedBy/.test(modal), '沒有鎖定機制');
  assert.ok(/disabled=\{!!lockedBy\}/.test(modal),
    'Ragic 認定的身分若可取消，存了下次同步也會回來，使用者會失去對系統的信任');
});

console.log(failures ? `\n${failures} FAILED` : '\nstaff_multi_role: ALL PASS');
process.exitCode = failures ? 1 : 0;

