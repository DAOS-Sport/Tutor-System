/**
 * 角色清單只能有一份。
 *
 * 這次修的 bug 是：五個地方各自寫死角色清單，互相矛盾 ——
 *   StaffPage 篩選 5 個 / StaffEditModal 4 個（缺救生員）/ roleLabel 5 個（標籤不同）
 *   BACKOFFICE_ROLES 3 個 / staff.VALID_ROLES 4 個（缺救生員）
 * 症狀是「篩選選得到救生員，進去編輯卻沒有這個選項，硬存會被後端回 400」，
 * 而且同一個 manager 在徽章上叫「場館主管」、在下拉裡叫「主管」。
 *
 * 這種漂移不會有人主動回報，只會累積。所以這裡盯三件事：
 *   1. 前後端兩份常數逐字相同（兩個獨立建置，沒辦法共用模組，只能用測試綁住）
 *   2. 沒有別的檔案再自己寫一份角色清單
 *   3. 「可指派」與「可登入後台」維持分開 —— 合併會讓「把救生員加進選單」
 *      順手發出後台權限，那是 F-A06 第 2 期要審慎處理的事
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const be = require(path.join(ROOT, 'server', 'constants', 'roles.js'));
const feSrc = fs.readFileSync(
  path.join(ROOT, 'client', 'admin', 'src', 'constants', 'roles.js'), 'utf8');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

// 前端是 ESM、跑在瀏覽器建置裡，這裡用解析而非 require。
function parseFrontendRoles(src) {
  const block = src.slice(src.indexOf('export const ROLES'), src.indexOf('];', src.indexOf('export const ROLES')));
  const out = [];
  const re = /key:\s*'([a-z_]+)'\s*,\s*label:\s*'([^']+)'\s*,\s*backoffice:\s*(true|false)\s*,\s*portal:\s*'([a-z]+)'/g;
  let m;
  while ((m = re.exec(block))) {
    out.push({ key: m[1], label: m[2], backoffice: m[3] === 'true', portal: m[4] });
  }
  return out;
}
const fe = parseFrontendRoles(feSrc);

check('前端解析得到 5 個角色', () => {
  assert.strictEqual(fe.length, 5, `實際解析到 ${fe.length} 個；解析壞掉的話下面每一條都會變成假通過`);
});

check('前後端角色清單逐字相同', () => {
  assert.deepStrictEqual(fe, be.ROLES.map((r) => ({ ...r })),
    '兩份常數已漂移。前端：' + JSON.stringify(fe) + '\n後端：' + JSON.stringify(be.ROLES));
});

check('救生員可以被指派（這是這次要修的）', () => {
  assert.ok(be.ASSIGNABLE_ROLES.includes('lifeguard'),
    '缺這個，篩選選得到但編輯存不了，後端會回 400「角色不合法」');
});

check('救生員可登入後台，教練永遠不可', () => {
  // 2026-08-26 使用者決定：救生員與櫃檯走同一個後台入口，
  // 看得到什麼由 F-A06 控制。教練則是走專屬 LIFF，永遠不進後台 ——
  // 那不是「還沒開放」，是設計上就不會有。
  assert.ok(be.BACKOFFICE_ROLES.includes('lifeguard'), '救生員要能登入後台');
  assert.ok(!be.BACKOFFICE_ROLES.includes('coach'),
    '教練若能登入後台，等於繞過 LIFF 那套身分；這條界線不該被無意改掉');
  assert.deepStrictEqual([...be.BACKOFFICE_ROLES],
    ['admin', 'manager', 'staff', 'lifeguard'],
    '可登入後台的角色變動會直接改變誰進得來，不該是無意的');
});

check('沒有別的檔案再自己寫一份角色清單', () => {
  const suspects = [
    'client/admin/src/pages/StaffEditModal.jsx',
    'client/admin/src/pages/StaffPage.jsx',
    'client/admin/src/utils/format.js',
    'server/middlewares/adminAuth.js',
    'server/routes/admin/staff.js',
  ];
  // 判準是「中括號裡的角色陣列字面值」，例如 ['admin','manager','staff','coach']。
  // 那正是重複清單長的樣子。刻意不抓下面這些合法用法：
  //   requireAdminRole('admin','manager','staff')      → 單一路由的權限閘門（第 4 期才換）
  //   ['admin','manager'].includes(r.role)             → 兩個鍵的條件判斷
  //   normalizeRoleFilter 的 ['admin','系統管理員',…]   → 外部字串對應，只含 1 個角色鍵
  // 早先用「一段裡出現 4 個以上角色鍵」，把這三種全抓成違規 —— 太鈍的判準
  // 會讓人習慣性忽略這個測試，那比沒有測試更糟。
  const ROLE_KEYS = ['admin', 'manager', 'staff', 'coach', 'lifeguard'];
  const offenders = [];
  for (const rel of suspects) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const lit of src.match(/\[[^\][]*\]/g) || []) {
      const hits = ROLE_KEYS.filter((r) => new RegExp("['\"]" + r + "['\"]").test(lit));
      if (hits.length >= 3) offenders.push(rel + ' → ' + lit.slice(0, 70));
    }
  }
  assert.deepStrictEqual(offenders, [],
    '這些地方又寫了一份角色清單，請改用 constants/roles： ' + offenders.join(' ; '));
});


check('教練不出現在權限表，但仍可被指派', () => {
  // 教練有專屬的 LIFF 入口，永遠不會進後台。列在 F-A06 裡那一欄永遠是空的，
  // 還會讓人以為自己漏設了什麼。但「指派某人為教練」仍然有意義（LIFF 身分、
  // 教練檔案），所以它必須留在可指派清單裡 —— 兩件事不能混為一談。
  assert.ok(!be.PORTAL_ADMIN_ROLES.includes('coach'), '教練不該出現在權限表');
  assert.ok(be.ASSIGNABLE_ROLES.includes('coach'), '教練仍必須可以指派');
  assert.deepStrictEqual([...be.PORTAL_ADMIN_ROLES],
    ['admin', 'manager', 'staff', 'lifeguard'],
    '權限表的欄位變了 —— 那會直接改變後台畫面，不該是無意的');
  const rp = fs.readFileSync(
    path.resolve(__dirname, '../server/routes/admin/rolePermissions.js'), 'utf8');
  assert.ok(/portal === 'admin'/.test(rp), 'F-A06 的 API 沒有依 portal 過濾');
});

console.log(failures ? `\n${failures} FAILED` : '\nrole_source_of_truth: ALL PASS');
process.exitCode = failures ? 1 : 0;

