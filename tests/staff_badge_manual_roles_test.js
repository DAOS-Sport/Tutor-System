/**
 * 清單徽章必須認得「後台手動指派的身分」
 *
 * 由來：2026-08-27 正式站回報「角色更換沒落進來」。管理員在 F-A02 編輯視窗勾了
 * 「救生員」並儲存，資料確實寫進 admin_staff_roles（查正式庫：lifeguard,staff），
 * 但清單那一排徽章仍然只顯示「行政櫃檯 + 教練」，看起來就像沒存到。
 *
 * 根因：rowToStaff 算 known_roles 時只看三個來源 ——
 *   role 保底值 / coaches 表 / is_lifeguard 旗標 —— 從頭到尾沒讀 admin_staff_roles。
 * 而登入裁決（auth.js）與權限矩陣（rolePermissions.js）早就讀那張表了，
 * 所以症狀特別容易被誤判：權限「其實有生效」，只有畫面不認。
 *
 * 兩條方向相反的規則都要守，缺一不可：
 *   1. 手動指派的身分要出現 —— 否則就是這次回報的 bug
 *   2. 純救生員不可以冒出「行政櫃檯」 —— 那是更早修過的 bug（role='staff' 只是
 *      CHECK constraint 的保底值）。修第 1 條時如果順手套了 manual_roles 那個
 *      「空就退回 [r.role]」的 fallback，第 2 條會立刻壞掉。
 */
'use strict';
const assert = require('assert');
const path = require('path');

const rowToStaff = require(path.join(__dirname, '..', 'server/routes/admin/staff.js'))._rowToStaff;

const base = { venue_ids: [], multiplier: 1, active: true };

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

check('掃描本身有效（rowToStaff 撈得到）', () => {
  assert.strictEqual(typeof rowToStaff, 'function',
    'staff.js 沒有匯出 _rowToStaff —— 下面每一條都會假通過');
});

check('手動指派的身分要出現在 known_roles（本次回報的 bug）', () => {
  // 莊柏彥在正式庫的真實資料：旗標全是 false，救生員只存在 admin_staff_roles。
  const out = rowToStaff({ ...base,
    id: '1305374', name: '莊柏彥', role: 'staff',
    is_counter: true, is_coach: false, is_lifeguard: false,
    manual_roles: ['lifeguard', 'staff'],
    coach_id: 'c-1', coach_active: true,
  });
  assert.ok(out.known_roles.includes('lifeguard'),
    '手動勾的「救生員」沒有進 known_roles，清單徽章就不會顯示 —— '
    + '資料明明存進去了，畫面卻毫無變化，使用者只會判斷成「沒存到」。實際得到：'
    + out.known_roles.join(', '));
});

check('純救生員不可以冒出「行政櫃檯」（守住更早修過的 bug）', () => {
  const out = rowToStaff({ ...base,
    id: 'X', name: '純救生員', role: 'staff',
    is_counter: false, is_coach: false, is_lifeguard: true,
    manual_roles: [],
  });
  assert.ok(!out.known_roles.includes('staff'),
    'role=\'staff\' 只是 CHECK constraint 的保底值，不代表他真的是櫃檯。'
    + '實際得到：' + out.known_roles.join(', '));
  assert.ok(out.known_roles.includes('lifeguard'), '救生員身分本身不見了');
});

check('assigned_roles 是原始值，不可以套 manual_roles 的 fallback', () => {
  // 這一條是上面兩條的分界線。fallback 會讓「沒有任何手動指派」看起來像
  // 「明確指派過 staff」，前端的抑制判斷就會失效，第 2 條跟著壞。
  const out = rowToStaff({ ...base,
    id: 'Y', name: '無指派', role: 'staff',
    is_counter: false, is_coach: false, is_lifeguard: true,
    manual_roles: [],
  });
  assert.deepStrictEqual(out.assigned_roles, [],
    '沒有手動指派時 assigned_roles 必須是空陣列，實際：' + JSON.stringify(out.assigned_roles));
  assert.deepStrictEqual(out.manual_roles, ['staff'],
    'manual_roles 的 fallback 行為被改動了 —— 那是既有相容行為，改它要另外評估');
});

check('前端的抑制判斷讀的是 assigned_roles，不是 manual_roles', () => {
  const fs = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'client/admin/src/pages/StaffPage.jsx'), 'utf8');
  const m = src.match(/const suppressStaffBadge = [^;]+;/);
  assert.ok(m, '找不到 suppressStaffBadge —— 掃描已失效');
  assert.ok(/assignedRoles/.test(m[0]),
    '抑制判斷沒有把「明確指派過 staff」列入例外：' + m[0]);

  // 光看 suppressStaffBadge 那一行不夠：危險的值可以在前一行就被綁進 assignedRoles。
  // 第一版的判準就是這樣被騙過去的 —— 把繫結改成 row.manual_roles，測試照樣全綠。
  const bind = src.match(/const assignedRoles = [^;]+;/);
  assert.ok(bind, '找不到 assignedRoles 的繫結 —— 掃描已失效');
  assert.ok(/row\.assigned_roles/.test(bind[0]),
    'assignedRoles 不是從 row.assigned_roles 來的：' + bind[0]);
  assert.ok(!/row\.manual_roles/.test(bind[0]),
    '繫結用了帶 fallback 的 manual_roles，純救生員會又冒出「行政櫃檯」：' + bind[0]);
});

console.log(failures ? '\n' + failures + ' FAILED' : '\nstaff_badge_manual_roles: ALL PASS');
process.exitCode = failures ? 1 : 0;
