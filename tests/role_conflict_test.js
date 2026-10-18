/**
 * 角色 × 模組的衝突稽核（F-A06 交叉檢查）。
 *
 * 這支測試斷言的是「應該要成立的行為」，不是目前的行為 —— 所以它現在是紅的。
 * 每一條紅的都對應一個已經確認的衝突；修好之後那一條就會轉綠。
 *
 * 這裡盯的東西跟既有的 role_permissions_test / lifeguard_login_test 不重疊：
 * 那兩支確認「三層有沒有讀同一份資料」，這一支確認「同一個問題在不同地方
 * 會不會得到不同答案」——
 *   「這個人的角色是什麼」    highestRole vs _effectiveLoginUser vs staff.js
 *   「這個人是不是 admin」    JWT 的 role vs 身分聯集
 *   「有哪些角色可以設定」    ROLES 全集 vs PORTAL_ADMIN_ROLES
 * 答案不一致的地方，症狀都是安靜的：沒有錯誤、沒有警告，只有某個人某天
 * 打不開某一頁，或是打得開他不該打開的頁。
 *
 * 不連資料庫：pool 用假的，餵固定的資料列進去，跑的是真正的判定程式碼。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const {
  ASSIGNABLE_ROLES, BACKOFFICE_ROLES, PORTAL_ADMIN_ROLES, highestRole,
} = require(path.join(ROOT, 'server/constants/roles'));
const { RESOURCE_KEYS } = require(path.join(ROOT, 'server/constants/adminResources'));

let failures = 0;
/** 同步與非同步都吃；一律 await，確保輸出順序就是閱讀順序。 */
async function check(label, fn) {
  try { await fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

// ── 假的 pool ────────────────────────────────────────────────────────────
//
// rolePermissions 只跟 models/db 要一個 pool。把它換掉就能用固定的資料列
// 跑真正的判定邏輯 —— 比對著程式碼用眼睛推導可靠得多，這幾條的差異
// 正好都藏在「哪個分支先命中」這種讀起來很容易看漏的地方。
const DB_PATH = require.resolve(path.join(ROOT, 'server/models/db.js'));
const SVC_PATH = require.resolve(path.join(ROOT, 'server/services/rolePermissions.js'));
const DB_WRITE_MARKER = '__DB_WRITE_ATTEMPTED__';

function loadService(fixture) {
  const pool = {
    query: async (sql) => {
      if (/FROM role_permissions/.test(sql)) {
        return { rows: fixture.rolePerms || [], rowCount: (fixture.rolePerms || []).length };
      }
      if (/FROM user_permission_overrides/.test(sql)) {
        return { rows: fixture.overrides || [], rowCount: (fixture.overrides || []).length };
      }
      if (/FROM admin_users u/.test(sql)) {
        return { rows: fixture.identities || [], rowCount: (fixture.identities || []).length };
      }
      throw new Error('假 pool 收到未預期的查詢：' + String(sql).slice(0, 60));
    },
    // 走到寫入＝前面的驗證全部放行了。用可辨識的錯誤標記出來。
    connect: async () => { throw new Error(DB_WRITE_MARKER); },
  };
  delete require.cache[SVC_PATH];
  require.cache[DB_PATH] = {
    id: DB_PATH, filename: DB_PATH, loaded: true,
    exports: { pool, guardCheckedOutClient: (c) => c },
  };
  return require(SVC_PATH);
}

// ── auth.js 的登入裁決：直接呼叫匯出的函式 ───────────────────────────────
// 原本是用正則把函式從原始碼挖出來、再用 new Function 重建。那個做法只要
// 函式呼叫到檔案裡的其他 helper（例如判斷保底值的 _usableRole）就會
// ReferenceError，而失敗訊息看起來像「這條斷言不成立」，實際上是 harness 壞了 ——
// 那種假紅比假綠更浪費時間。auth.js 現在把它掛在 module.exports 上供測試使用。
const AUTH_SRC = read('server/routes/admin/auth.js');
const effectiveLoginUser = require(
  path.join(ROOT, 'server/routes/admin/auth.js'))._effectiveLoginUser;
assert.strictEqual(typeof effectiveLoginUser, 'function',
  'auth.js 沒有匯出 _effectiveLoginUser —— 登入裁決那幾條會全部驗不到');

/** 這個人的後台代表角色「應該」是什麼：所有身分濾掉非後台角色，取最高。 */
function expectedLoginRole(identities) {
  return highestRole(identities.filter((r) => BACKOFFICE_ROLES.includes(r)));
}

// token 是 admin、但連到的 admin_staff 列已被改成 manager 的帳號。
// 這是第三節共用的情境，抽出來讓兩條斷言吃同一份資料。
const ADMIN_TOKEN_MISMATCH = {
  rolePerms: [{ role: 'manager', resource_key: 'reports' }],
  overrides: [],
  identities: [{
    user_id: 'U1', role: 'manager',
    is_counter: false, is_coach: false, is_lifeguard: false, manual_roles: ['manager'],
  }],
};
const ADMIN_WHO = { role: 'admin', userId: 'U1' };

// 用 \w+ 而不是反向參照：反向參照要寫 \\1，而那個跳脫在這條工具鏈上會被吃成控制字元 \x01。
const FLAG_FROM_QUERY = 'const\\s+\\w+\\s*=\\s*await\\s+pool\\.query\\([\\s\\S]{0,240}?schema_seed_marks[\\s\\S]{0,240}?\\);\\s*if\\s*\\(\\w+\\.rowCount\\)\\s*return;';

async function main() {
  // ══ 一、登入的角色裁決：_effectiveLoginUser 自己排了一套順序 ════════════
  //
  // constants/roles 說「highestRole 是唯一裁決者」，但 auth.js:42 的
  // _effectiveLoginUser 是手寫的四段 if，而且只讀 admin_staff.role 與 Ragic 的
  // is_counter / is_coach / is_lifeguard 三個旗標 —— 完全沒有讀 admin_staff_roles。
  // 那張表正是「管理員在後台手動加上的身分」，也就是多選身分功能的全部意義。

  await check('對照組：純行政櫃檯的裁決一致（確認這組工具本身沒壞）', () => {
    const got = effectiveLoginUser({
      staff_id: 'E4', staff_role: 'staff', role: 'staff',
      is_counter: false, is_coach: false, is_lifeguard: false,
    });
    assert.strictEqual(got && got.role, 'staff');
    assert.strictEqual(expectedLoginRole(['staff']), 'staff');
  });

  await check('「行政櫃檯＋救生員」登入後仍是行政櫃檯，不可被降級成救生員', () => {
    // 管理員在 F-A02 勾了「行政櫃檯 + 救生員」→ admin_staff.role = highestRole = 'staff'；
    // 這個人同時被 Ragic 認定為救生員（is_lifeguard = TRUE），但沒有 is_counter
    // （櫃檯身分是後台手動加的，Ragic 上看不出來）。
    //
    // auth.js:52 的櫃檯分支寫的是
    //     u.is_counter || (staffRole === 'staff' && !u.is_coach && !u.is_lifeguard)
    // 括號裡的 !u.is_lifeguard 把他排除掉，於是掉到 auth.js:60 的救生員分支。
    // 結果他的 JWT 變成 lifeguard，而 _issueLogin 還會把 admin_users.role
    // 一起改寫成 lifeguard —— 管理員存進去的「行政櫃檯」被無聲抹掉。
    // 畫面上他從此顯示為救生員，F-A06 的個人權限頁也會拿救生員的預設清單
    // （只有 dashboard / sop）去跟他的實際權限比對，看起來像是設錯了。
    //
    // auth.js:56-58 的註解正好宣告這件事不該發生：
    //   「櫃檯兼救生員的人實際在做櫃檯的事，排在前面會把他降級成救生員」。
    const got = effectiveLoginUser({
      staff_id: 'E1', staff_role: 'staff', role: 'staff',
      is_counter: false, is_coach: false, is_lifeguard: true,
      // 管理員勾的是「行政櫃檯 + 救生員」，admin_staff_roles 兩列都在。
      // 原本這個 fixture 不給 manual_roles，因為當時的 _effectiveLoginUser
      // 根本不讀它 —— 但那也讓「修好之後」無從驗起：沒有這個欄位，
      // 「他也是櫃檯」這件事在資料上真的不存在，回 lifeguard 才是對的。
      manual_roles: ['staff', 'lifeguard'],
    });
    assert.strictEqual(got && got.role, expectedLoginRole(['staff', 'lifeguard']),
      `_effectiveLoginUser 給 ${got ? got.role : 'null'}，highestRole 給 staff`);
  });

  await check('手動加上的「救生員」身分要能登入（教練兼救生員）', () => {
    // 14 位教練兼救生員裡，Ragic 只標到教練的那些人，救生員是管理員手動補的。
    // admin_staff.role = highestRole(['coach','lifeguard']) = 'coach'
    //   —— 因為 highestRole 走的是 ASSIGNABLE_ROLES 全集，coach 的優先序比
    //      lifeguard 高，但 coach 根本不是後台角色。
    // 於是 _effectiveLoginUser 四段分支全部落空：staffRole 是 'coach' 不是
    // 'staff' 也不是 'lifeguard'，Ragic 的 is_lifeguard 又是 false。
    // 回傳 null → 登入直接回 null → 畫面顯示「帳號或密碼錯誤」。
    //
    // 管理員會看到身分存好了、權限聯集也算得到（rolePermissions 有讀
    // admin_staff_roles），只有登入這一關不認 —— 而錯誤訊息說的是密碼錯。
    //
    // 對照組：auth.js:169 的 _counterStaffDefaultLogin 有做對，它先
    //   identities.filter((r) => BACKOFFICE_ROLES.includes(r)) 再 highestRole。
    // 同一個檔案裡兩套算法。
    const got = effectiveLoginUser({
      staff_id: 'E2', staff_role: 'coach', role: 'staff',
      is_counter: false, is_coach: true, is_lifeguard: false,
      manual_roles: ['coach', 'lifeguard'],
    });
    assert.strictEqual(got && got.role, expectedLoginRole(['coach', 'lifeguard']),
      `_effectiveLoginUser 給 ${got ? got.role : 'null（登入被拒）'}，應為 lifeguard`);
  });

  await check('手動加上的「行政櫃檯」身分要能登入（教練兼櫃檯）', () => {
    // 同一個根因的另一種樣子：admin_staff.role = highestRole(['staff','coach']) = 'staff'，
    // 但 Ragic 的 is_coach = true，於是 auth.js:52 括號裡的 !u.is_coach 把他排除，
    // 救生員分支也不中 → null → 登不進去。
    // 症狀：管理員幫某位教練開了櫃檯身分，對方隔天說「密碼錯誤」。
    const got = effectiveLoginUser({
      staff_id: 'E3', staff_role: 'staff', role: 'staff',
      is_counter: false, is_coach: true, is_lifeguard: false,
      manual_roles: ['staff', 'coach'],
    });
    assert.strictEqual(got && got.role, expectedLoginRole(['staff', 'coach']),
      `_effectiveLoginUser 給 ${got ? got.role : 'null（登入被拒）'}，應為 staff`);
  });

  await check('登入裁決要讀得到手動指派的身分表', () => {
    // 上面三條的共同根因。admin_staff_roles 是多選身分的權威來源，
    // 登入那一關卻只看 admin_staff.role 這個「代表值」加上 Ragic 的三個旗標。
    // 代表值是有損壓縮：['staff','lifeguard'] 壓成 'staff' 之後，
    // 「他也是救生員」這件事就只能靠 Ragic 旗標補回來，補不回來就錯。
    const m = AUTH_SRC.match(/function _effectiveLoginUser[\s\S]*?\n}/);
    assert.ok(/admin_staff_roles|manual_roles/.test(m[0]),
      '_effectiveLoginUser 沒有讀 admin_staff_roles，手動指派的後台身分對登入完全無效');
  });

  // ══ 二、第三套角色映射：staff.js 手寫的 coach → staff ═══════════════════

  await check('staff.js 不可自己一套「coach 換成 staff」的映射', () => {
    // staff.js:842（POST /staff）與 staff.js:998（PATCH /staff/:id）都有：
    //     const loginRole = merged.role === 'coach' ? 'staff' : merged.role;
    // 然後拿它寫進 admin_users.role。
    //
    // 這正是 lifeguard_login_test 擋掉的那個舊寫法的變體：「不是 X 就一律 staff」。
    // 後果：
    //   1. 教練的登入帳號被記成「行政櫃檯」。F-A06 的個人權限頁（GET
    //      /role-permissions/users/:id）用 admin_users.role 去算 role_allowed，
    //      於是那位教練顯示成行政櫃檯、預設清單是整套櫃檯權限。
    //   2. 教練兼救生員的人 merged.role 是 'coach'（highestRole 全集），
    //      loginRole 被寫成 'staff' 而不是 'lifeguard' —— 又是一個代表值被算錯。
    //
    // 正確做法就在同一個 repo 裡：auth.js:169 的
    //   highestRole(identities.filter((r) => BACKOFFICE_ROLES.includes(r)))
    // 先把註解整段拿掉再掃。解釋「原本這裡寫的是什麼、為什麼改掉」的註解
    // 一定會引用那個舊寫法，掃到它等於懲罰把來龍去脈寫清楚的人。
    const staffJs = read('server/routes/admin/staff.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(String.fromCharCode(10)).filter((l) => !/^\s*\/\//.test(l)).join(String.fromCharCode(10));
    const hits = [...staffJs.matchAll(/===\s*'coach'\s*\?\s*'staff'/g)];
    assert.strictEqual(hits.length, 0,
      `staff.js 有 ${hits.length} 處手寫的 coach→staff 映射，`
      + '應改用 highestRole + BACKOFFICE_ROLES 過濾，否則後台代表角色有三套算法');
  });

  await check('代表值可以不是後台角色，但不能因此少了身分或登不進來', () => {
    // staff.js 的 patch.role = highestRole(manualRoles) 走 ASSIGNABLE_ROLES 全集，
    // coach 排在 lifeguard 前面 —— 所以「教練＋救生員」的 admin_staff.role 是 'coach'。
    //
    // 這條原本主張「代表值不該由全集決定」，理由是那個值登入裁決不認、該員登不進來。
    // 那個理由現在不成立：登入已改讀 admin_staff_roles（上面第 3 條就是驗這件事）。
    // 而且代表值算成 coach 在語意上是對的 —— 那個人主要就是教練，
    // 列表徽章顯示「教練」才符合直覺，硬改成 lifeguard 反而製造新的困惑。
    //
    // 所以真正要盯的不是「代表值是什麼」，而是「有沒有人把代表值當成唯一來源」。
    // 消費它的地方有三處：登入裁決、取得預設帳號的資格查詢、權限身分聯集。
    const authSrc = read('server/routes/admin/auth.js');
    const permSrc = read('server/services/rolePermissions.js');

    // 1) 登入裁決 —— 直接餵一個代表值是 coach 的人
    const got = effectiveLoginUser({
      staff_id: 'E5', staff_role: 'coach', role: 'staff',
      is_counter: false, is_coach: true, is_lifeguard: false,
      manual_roles: ['coach', 'lifeguard'],
    });
    assert.strictEqual(got && got.role, 'lifeguard',
      '代表值是 coach 就登不進來 —— 登入裁決仍然只看代表值');

    // 2) 取得預設帳號的資格查詢
    // 錨在函式宣告，不是第一次出現 —— 別處的註解也會提到這個名字，
    // 從註解算起 2500 字元根本到不了查詢本體，會得到一個假紅。
    const i = authSrc.indexOf('async function _counterStaffDefaultLogin');
    assert.ok(i > 0, '找不到 _counterStaffDefaultLogin 的宣告，掃描失效');
    assert.ok(authSrc.slice(i, i + 2500).includes('admin_staff_roles'),
      '登入資格的 WHERE 沒有考慮 admin_staff_roles —— 代表值是 coach 的人會被整個濾掉，'
      + '症狀是「密碼正確但顯示帳號或密碼錯誤」');

    // 3) 權限的身分聯集
    assert.ok(permSrc.includes('manual_roles'),
      '身分聯集沒有讀 admin_staff_roles，手動指派的身分不會有權限');
  });

  // ══ 三、「這個人是不是 admin」有兩個互不相干的答案 ══════════════════════
  //
  // 後端 canUserAccess（rolePermissions.js:113）判的是「身分聯集裡有沒有 admin」，
  // 而身分聯集（同檔 85-87 行）在帳號有連到 admin_staff 時會**整個丟掉 token 上的
  // role**，只用 admin_staff.role + Ragic 旗標 + admin_staff_roles。
  // 但 token 上的 role 才是其他所有地方認的那個：
  //   requireAdminRole('admin')                 middlewares/adminAuth.js:99
  //   getScopedVenueIds / isVenueInScope        middlewares/adminAuth.js:80, 92
  //   前端 can()                                PermissionContext.jsx:38
  //   前端路由守衛                               RequireAuth.jsx
  // 四對一。兩邊分歧時，人會看到「選單全開、每一頁點進去都 403」。
  //
  // 情境怎麼發生：管理員在 F-A02 把某位系統管理員改成場館主管。
  // 那個操作只寫 admin_staff（以及 admin_users 的 name/venue），
  // 而 _effectiveLoginUser 只要 admin_users.role 還是 admin 就一直發 admin 的 token。

  await check('token 是 admin 時，後端閘門也要當他是 admin', async () => {
    // 現況：canUserAccess 回 false，因為身分聯集是 { manager }。
    // 同一個請求裡 requireAdminRole('admin') 卻會放行（它看 token）——
    // 於是這個人改得動角色權限設定（PUT /role-permissions/:role），
    // 卻打不開 /settings。權限比他小的主管反而打得開。
    const svc = loadService(ADMIN_TOKEN_MISMATCH);
    const ok = await svc.canUserAccess(ADMIN_WHO, 'settings');
    const seen = [...(await svc.rolesOf(ADMIN_WHO))];
    assert.strictEqual(ok, true,
      `canUserAccess 拒絕了一個 token 為 admin 的請求（身分聯集 = ${JSON.stringify(seen)}）；`
      + "requireAdminRole('admin') 與前端 can() 對同一個人的答案是 true —— 系統內部不一致");
  });

  await check('/mine 回給側邊選單的清單也要與 token 的 admin 一致', async () => {
    // effectiveResources（rolePermissions.js:127）用同一份身分聯集。
    // 前端 PermissionContext.can() 在 role === 'admin' 時直接回 true，
    // 完全不看 /mine 的內容 —— 所以畫面照樣畫出 34 個入口，
    // 而後端只認 manager 的那幾頁。這就是「藏起來但打得進去」的反面：
    // 「看得到但打不進去」，而且受害者是系統管理員本人。
    const svc = loadService(ADMIN_TOKEN_MISMATCH);
    const eff = await svc.effectiveResources(ADMIN_WHO);
    assert.strictEqual(eff.length, RESOURCE_KEYS.length,
      `effectiveResources 只回了 ${eff.length} 頁（${JSON.stringify(eff)}），`
      + `token 為 admin 應回全部 ${RESOURCE_KEYS.length} 頁`);
  });

  await check('前後端對 admin 的判定要來自同一個依據', () => {
    // 這一條不主張哪一邊該讓步：可以是「後端也承認 token 的 admin」，
    // 也可以是「前端與 requireAdminRole 都改讀身分聯集」。
    // 不能接受的是現在這樣 —— 兩邊各自有一套，而且沒有任何東西讓它們對齊。
    const ctx = read('client/admin/src/context/PermissionContext.jsx');
    const svc = read('server/services/rolePermissions.js');
    const frontUsesToken = /role === 'admin'/.test(ctx);
    const backDropsToken = /if \(fromDb && fromDb\.size\) return fromDb;/.test(svc);
    assert.ok(!(frontUsesToken && backDropsToken),
      '前端 can() 依 token 的 role 判 admin（PermissionContext.jsx:38），'
      + '後端 _rolesOf 卻在帳號連到 admin_staff 時丟掉 token 的 role'
      + '（rolePermissions.js:86）—— 同一個人兩個答案');
  });

  // ══ 四、提權：改權限的門鎖住了，發角色的門沒鎖 ══════════════════════════
  //
  // routes/admin/rolePermissions.js 的註解把風險說得很清楚：
  //   「只用 requireResource 會開出一條提權路徑 —— 管理員把這一頁勾給主管，
  //     主管就能把任何權限發給自己」
  // 所以 PUT /role-permissions/:role 與 PUT /users/:userId 都用了
  // requireAdminRole('admin')。但 F-A02（員工帳號管理）整支 staff.js 沒有任何
  // requireAdminRole，全部只有 requireResource('staff') —— 而那支 API 能指派角色。

  await check('能指派角色的端點不可只靠資源權限把關', () => {
    // 管理員把「員工帳號管理」勾給場館主管之後，該主管可以：
    //   PATCH /api/admin/staff/<自己的員工編號>  { roles: ['admin'] }
    // → admin_staff_roles 多一列 'admin' → rolePermissions._rolesOf 把它算進
    //   身分聯集 → canUserAccess 的 roles.has('admin') 成立 → 快取 15 秒後全開。
    // 另外兩條更短的路：
    //   POST /api/admin/staff { role: 'admin', ... }   直接新建一個管理員帳號
    //   POST /api/admin/staff/:id/reset-password       直接重設現任管理員的密碼
    //
    // ── 為什麼不是要求 requireAdminRole('admin') 掛在路由上 ──
    // 那會把整個 F-A02 鎖成 admin 專用，「把員工帳號管理委派給場館主管」
    // 這件事就不可能了 —— 而那正是 F-A06 存在的意義。要擋的是「發出 admin
    // 這個特定角色」，不是「進入這支路由」。所以判準是：路由層限 admin，
    // 或者處理函式裡有一個依 payload 判斷的守衛，兩者成立其一即可。
    //
    // 掃描前先拿掉註解：這段說明本身就引用了 requireAdminRole('admin')，
    // 不拿掉的話它會讓下面每一條都變成假綠。
    const staffJs = read('server/routes/admin/staff.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(String.fromCharCode(10)).filter((l) => !/^\s*\/\//.test(l)).join(String.fromCharCode(10));

    // 守衛的「行為」要對 —— 不是「檔案裡找得到一個長這樣的函式」。
    // 原本這裡是讀原始碼比對，於是把守衛第一行改成 return null 仍然全綠（實測過）。
    const { adminGrantBlocked } = require(
      path.join(ROOT, 'server/services/adminGrantGuard.js'));
    const guardName = 'adminGrantBlocked';
    const asAdmin = { adminUser: { role: 'admin' } };
    const asManager = { adminUser: { role: 'manager' } };
    assert.ok(adminGrantBlocked(asManager, ['admin']),
      '非 admin 指派 admin 沒有被擋 —— 這就是那條提權路徑');
    assert.strictEqual(adminGrantBlocked(asAdmin, ['admin']), null,
      'admin 自己也被擋住了，那 F-A02 就沒人能用');
    assert.strictEqual(adminGrantBlocked(asManager, ['manager', 'staff']), null,
      '不含 admin 的指派被擋住 —— 委派出去的「員工帳號管理」會整個不能用');
    assert.ok(adminGrantBlocked(asManager, ['staff', 'admin']),
      '夾在陣列中間的 admin 沒被認出來');
    assert.ok(adminGrantBlocked({}, ['admin']),
      '沒有 adminUser 的請求應一律擋下，不是放行');

    // 三支能改變身分或取得帳號的端點，各自都要被守衛擋過。
    const ENDPOINTS = [
      ["POST /", /router\.post\('\/',[\s\S]*?\n\}\);/],
      ["PATCH /:id", /router\.patch\('\/:id',[\s\S]*?\n\}\);/],
      ["POST /:id/reset-password", /router\.post\('\/:id\/reset-password',[\s\S]*?\n\}\);/],
    ];
    const unguarded = [];
    for (const [label, re] of ENDPOINTS) {
      const m = staffJs.match(re);
      if (!m) { unguarded.push(label + ' → 找不到這支路由，掃描失效'); continue; }
      const head = m[0].slice(0, m[0].indexOf('=>'));
      const routeLevel = /requireAdminRole\(/.test(head);
      // 用 indexOf 而不是動態 RegExp：組正則要塞反斜線，而反斜線在這條工具鏈上很容易被吃掉一層，
      // 變成一個語法合法但比對錯誤的正則 —— 那會是假綠。
      const inHandler = m[0].includes(guardName + '(');
      if (!routeLevel && !inHandler) unguarded.push(label);
    }
    assert.deepStrictEqual(unguarded, [],
      "這些端點能寫 admin_staff.role / admin_staff_roles 或取得帳號，"
      + '卻沒有任何一層擋住「發出 admin」。被授權「員工帳號管理」的主管'
      + '可以把自己指派成 admin，正是 rolePermissions.js 註解裡說要防的那條提權路徑：'
      + unguarded.join('、'));
  });

  await check('可被指派的角色清單不該讓非 admin 發得出 admin', () => {
    // staff.js 的 VALID_ROLES 就是 ASSIGNABLE_ROLES，含 'admin'；
    // 角色驗證只檢查「在不在清單裡」，沒有檢查「呼叫者夠不夠格發這個角色」。
    // 兩件事至少要成立一件：端點限 admin，或者發 admin 這個角色本身要另外把關。
    //
    // 這一條原本會被註解騙過去：判準是「檔案裡出現 requireAdminRole('admin')」，
    // 而一段解釋「為什麼這裡不用 requireAdminRole('admin')」的 JSDoc 就足以讓它變綠。
    // 假綠比假紅糟得多 —— 它會讓人以為提權已經修好了。所以先拿掉註解再掃。
    const staffJs = read('server/routes/admin/staff.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(String.fromCharCode(10)).filter((l) => !/^\s*\/\//.test(l)).join(String.fromCharCode(10));
    assert.ok(/ASSIGNABLE_ROLES: VALID_ROLES/.test(staffJs),
      '前提變了：staff.js 的 VALID_ROLES 不再是 ASSIGNABLE_ROLES，這條要重寫');
    assert.ok(ASSIGNABLE_ROLES.includes('admin'));
    // 守衛已抽到 services/adminGrantGuard.js（純模組才驗得到行為）。
    // 這裡看的是 staff.js 有沒有真的把它接上：import 進來而且有呼叫。
    const guarded = /requireAdminRole\('admin'\)/.test(staffJs)
      || (/require\(['"][^'"]*adminGrantGuard['"]?/.test(staffJs)
          && /adminGrantBlocked\(/.test(staffJs));
    assert.ok(guarded,
      'staff.js 允許把 role/roles 設成 admin，且沒有任何一處要求呼叫者本身是 admin');
  });

  // ══ 五、教練欄位：設定得了、看不見、卻會生效 ════════════════════════════
  //
  // constants/roles 把 ASSIGNABLE_ROLES（5 個，可指派）與 PORTAL_ADMIN_ROLES
  // （4 個，會出現在權限矩陣）刻意分開，理由寫得很明白：教練走 LIFF。
  // 但 services/rolePermissions.js 有兩處直接用了 ROLES 全集。

  await check('admin_staff.role 的保底值不該變成一個真的身分', async () => {
    // admin_staff.role 有 CHECK constraint、一定要有值，所以純教練與純救生員
    // 都落在保底值 'staff'。身分聯集若無條件把它加進去，那些人就憑空多一個
    // 「行政櫃檯」—— 拿到客戶資料、對帳、退款的全部權限，而畫面上他的徽章
    // 顯示的是救生員，完全看不出來。
    //
    // 這條是 mutation test 補出來的：把過濾拿掉、改回無條件 set.add(row.role)，
    // 當時整套測試仍然全綠。
    const svc = loadService({
      rolePerms: [{ role: 'staff', resource_key: 'customer-parents' }],
      overrides: [],
      identities: [{
        user_id: 'U9', role: 'staff',
        is_counter: false, is_coach: false, is_lifeguard: true, manual_roles: [],
      }],
    });
    const who = { role: 'lifeguard', userId: 'U9' };
    const seen = [...(await svc.rolesOf(who))];
    assert.ok(!seen.includes('staff'),
      '純救生員的身分聯集裡出現了 staff：' + JSON.stringify(seen));
    assert.strictEqual(await svc.canUserAccess(who, 'customer-parents'), false,
      '純救生員從保底值拿到了行政櫃檯的客戶資料權限');
  });

  await check('權限矩陣的欄位只能是 PORTAL_ADMIN_ROLES', async () => {
    // rolePermissions.js:149 `for (const r of ROLES)` → getMatrix 回 5 個 key。
    // 而 routes/admin/rolePermissions.js:46 送給前端的 roles 只有 4 個
    // （filter portal === 'admin'）。多出來的 coach 欄位前端永遠不會畫，
    // 於是它的內容既看不到也改不掉。
    const svc = loadService({ rolePerms: [], overrides: [], identities: [] });
    const cols = Object.keys(await svc.getMatrix());
    assert.deepStrictEqual(cols, [...PORTAL_ADMIN_ROLES],
      `getMatrix 回 ${JSON.stringify(cols)}，但 GET /role-permissions 只把 `
      + `${JSON.stringify([...PORTAL_ADMIN_ROLES])} 送給前端`);
  });

  await check('寫入端要拒絕不會出現在矩陣上的角色', async () => {
    // rolePermissions.js:165 用 `ROLES.some(...)` 驗證角色 —— 所以
    // PUT /api/admin/role-permissions/coach 會通過驗證並真的寫進資料表。
    // UI 送不出這個請求，但它是一支開著的 API，而寫進去的東西沒有任何畫面看得到。
    const svc = loadService({ rolePerms: [], overrides: [], identities: [] });
    let code = null;
    try { await svc.setRolePermissions('coach', ['refund']); }
    catch (e) { code = e.code || e.message; }
    assert.strictEqual(code, 'UNKNOWN_ROLE',
      code === DB_WRITE_MARKER
        ? 'setRolePermissions("coach") 通過驗證並開始寫入 —— coach 不在權限矩陣上，'
          + '寫進去的列沒有任何畫面看得到，也沒有任何畫面刪得掉'
        : `預期擋下 coach，實際得到：${code}`);
  });

  await check('矩陣上看不到的角色不該左右權限判定', async () => {
    // 收尾的那一刀：coach 的列不只是躺著。canUserAccess 走的是身分聯集，
    // 而 _rolesOf 會把 is_coach 加進集合。所以一位「教練兼救生員」的後台帳號
    // 會拿到 coach 欄位的全部權限 —— 管理員在 F-A06 頁面上只看得到
    // 救生員那一欄（dashboard / sop），完全不知道權限是從哪裡來的。
    const svc = loadService({
      rolePerms: [{ role: 'coach', resource_key: 'refund' }],
      overrides: [],
      identities: [{
        user_id: 'U9', role: 'lifeguard',
        is_counter: false, is_coach: true, is_lifeguard: true, manual_roles: [],
      }],
    });
    const ok = await svc.canUserAccess({ role: 'lifeguard', userId: 'U9' }, 'refund');
    assert.strictEqual(ok, false,
      '救生員帳號從 coach 這個「矩陣上不存在」的欄位拿到了退課處理的權限；'
      + '管理員在畫面上看不到 coach 欄，也就無從發現、無從收回');
  });

  // ══ 六、初始灌入：用「表是空的」當成「還沒初始化」 ══════════════════════

  await check('重新灌入的判斷不能用「表裡有沒有列」', () => {
    // rolePermissions.js:setRolePermissions 是 DELETE 再 INSERT，
    // 且 `if (keys.length)` —— 送空陣列就只剩 DELETE。
    // 權限矩陣上可編輯的只有 manager / staff / lifeguard 三欄（admin 鎖住、
    // 不入表），管理員若把這三欄全部取消勾選（例如出事時先全部關掉），
    // role_permissions 會變成空表。若初始化旗標是「表裡有沒有列」，
    // 下一次部署就會認定「還沒初始化」，把整份預設矩陣重新灌回去 ——
    // 剛剛關掉的權限全部自己打開，而且沒有任何紀錄說明發生過什麼。
    //
    // 判準不是「不准出現那句 SQL」：舊環境在旗標機制出現之前就已經灌過了，
    // 需要一次性地認出「這裡已經初始化過」並補記旗標，那個分支合法。
    // 要盯的是「灌入這個動作本身由持久旗標決定」。
    const schema = read('server/bootstrap/coreSchema.js');
    const m = schema.match(/async function ensureRolePermissions[\s\S]*?\n}/);
    assert.ok(m, '找不到 ensureRolePermissions');
    const body = m[0];

    // 不只是「檔案裡提到 schema_seed_marks」—— 那個字串留在註解裡也算數。
    // 旗標必須真的來自一次 await 查詢，而且那個結果要直接決定要不要提前結束。
    // 這條是 mutation test 補出來的：把查詢換成 { rowCount: 0 } 字面值之後
    // 原本的判準仍然全綠。
    const flagged = new RegExp(FLAG_FROM_QUERY).test(body);
    assert.ok(flagged,
      '初始化旗標不是來自一次真實查詢，或查詢結果沒有直接決定是否提前結束');

    const iMark = body.indexOf('schema_seed_marks');
    const iSeed = body.indexOf('INSERT INTO role_permissions');
    assert.ok(iSeed > 0, '找不到灌入的 INSERT，掃描失效');
    assert.ok(iMark < iSeed, '旗標檢查排在灌入之後，等於沒有把關');

    const legacy = body.indexOf('SELECT 1 FROM role_permissions LIMIT 1');
    if (legacy >= 0) {
      const branch = body.slice(legacy, legacy + 500);
      assert.ok(/schema_seed_marks/.test(branch) && branch.indexOf('return') > 0,
        '還在用「表是否為空」決定要不要灌 —— 相容分支只能補記旗標然後結束，'
        + '不能拿它當初始化判準');
      assert.ok(legacy < iSeed && legacy > iMark,
        '相容分支的位置不對：它必須排在旗標檢查之後、灌入之前');
    }
  });

  console.log(failures ? `\n${failures} FAILED` : '\nrole_conflict: ALL PASS');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error('測試本身炸了（不是斷言失敗）：', e);
  process.exitCode = 1;
});
