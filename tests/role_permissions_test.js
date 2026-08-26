/**
 * F-A06 角色權限：資源清單與前端三層的一致性。
 *
 * 這個功能的核心風險是「藏起來但打得進去」——選單、路由守衛、後端閘門是三層
 * 各自獨立的東西，只要有一層沒接上同一份設定，畫面就會讓人以為權限已經關掉了。
 * 所以這裡盯的不是勾選邏輯，而是「三層有沒有真的讀同一份資料」。
 *
 * 不連資料庫：資料面的行為由端到端測試涵蓋（改權限 → /mine 跟著變）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { ADMIN_RESOURCES, RESOURCE_KEYS } = require(
  path.join(ROOT, 'server', 'constants', 'adminResources'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

check('資源代號不重複', () => {
  assert.strictEqual(new Set(RESOURCE_KEYS).size, RESOURCE_KEYS.length,
    '重複的 key 會讓兩個頁面共用同一格勾選');
});

check('每個資源都有 key / group / path / label / defaultRoles', () => {
  for (const r of ADMIN_RESOURCES) {
    for (const f of ['key', 'group', 'path', 'label']) {
      assert.ok(r[f], `${r.key || '(無 key)'} 缺 ${f}`);
    }
    assert.ok(Array.isArray(r.defaultRoles), `${r.key} 的 defaultRoles 不是陣列`);
  }
});

check('key 與 path 對得起來（選單與守衛都靠這個推導）', () => {
  for (const r of ADMIN_RESOURCES) {
    assert.strictEqual(r.key, r.path.replace(/^\//, ''),
      `${r.path} 的 key 應為 ${r.path.replace(/^\//, '')}，實際是 ${r.key}`);
  }
});

check('F-A06 自己也在清單裡', () => {
  assert.ok(RESOURCE_KEYS.includes('role-permissions'),
    '新頁面若不入清單就只能寫死權限，等於自己跳過自己管的規則');
});

check('側邊選單的每一個項目都有對應資源', () => {
  const nav = read('client/admin/src/components/Sidebar.jsx');
  const paths = [...nav.matchAll(/to:\s*'(\/[^']*)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 30, `只抓到 ${paths.length} 個選單項目，解析可能壞了`);
  const missing = paths.filter((p) => !RESOURCE_KEYS.includes(p.replace(/^\//, '')));
  assert.deepStrictEqual(missing, [],
    '這些選單項目沒有對應的資源代號，會永遠顯示不出來：' + missing.join('、'));
});

check('選單改讀權限設定，不再只看寫死的 roles', () => {
  const nav = read('client/admin/src/components/Sidebar.jsx');
  assert.ok(/usePermissions/.test(nav), 'Sidebar 沒有接上 usePermissions');
  assert.ok(/canSee\(it, role, allowed, can\)/.test(nav),
    'canSee 沒有把權限資料傳進去，勾選不會生效');
});

check('路由守衛也改讀權限設定', () => {
  const ra = read('client/admin/src/components/RequireAuth.jsx');
  assert.ok(/usePermissions/.test(ra), 'RequireAuth 沒有接上 usePermissions');
  assert.ok(/allowed === null/.test(ra),
    '載入中要退回舊的 roles 判定，否則每次重整都會閃一下「沒有權限」');
});

check('系統管理員不可被調整（防止把自己鎖在門外）', () => {
  const svc = read('server/services/rolePermissions.js');
  assert.ok(/ADMIN_ROLE_IMMUTABLE/.test(svc), '服務層沒有擋 admin');
  assert.ok(/if \(role === 'admin'\) return true;/.test(svc),
    'canAccess 沒有給 admin 捷徑，改壞設定就會鎖死');
});

check('認不得的資源代號一律拒絕（fail-closed）', () => {
  const svc = read('server/services/rolePermissions.js');
  assert.ok(/if \(!isResourceKey\(resourceKey\)\) return false;/.test(svc),
    '未知的 key 必須拒絕，不能因為查不到就放行');
});

// ── 第二層：個別人員例外 ────────────────────────────────────
//
// 例外的判定順序錯了會直接變成權限漏洞，而症狀是「某個人多了/少了一頁」——
// 不會有人主動回報「我好像多看得到東西」。所以這幾條盯得比較死。

check('例外壓在角色之上（否則收回權限永遠做不到）', () => {
  const svc = read('server/services/rolePermissions.js');
  const m = svc.match(/async function canUserAccess[\s\S]*?\n}/);
  assert.ok(m, '找不到 canUserAccess');
  const body = m[0];
  const iOverride = body.indexOf('ov.has(resourceKey)');
  const iRole = body.indexOf('canAccess(role');
  assert.ok(iOverride > 0 && iRole > 0, '判定裡缺少例外或角色其中一段');
  assert.ok(iOverride < iRole,
    '角色檢查排在例外之前，會讓「單獨收回」失效 —— 那正是例外最常見的用途');
});

check('admin 仍在最前面（不可被例外鎖住）', () => {
  const svc = read('server/services/rolePermissions.js');
  const m = svc.match(/async function canUserAccess[\s\S]*?\n}/);
  assert.ok(/if \(role === 'admin'\) return true;/.test(m[0]),
    '管理員必須在任何例外之前放行，否則有人能把管理員鎖在門外');
});

check('例外是布林，不是「有列＝允許」', () => {
  const schema = read('server/bootstrap/coreSchema.js');
  const m = schema.match(/CREATE TABLE IF NOT EXISTS user_permission_overrides[\s\S]*?\)/);
  assert.ok(m, '找不到 user_permission_overrides 的定義');
  assert.ok(/allowed\s+BOOLEAN NOT NULL/.test(m[0]),
    '沒有布林欄位就表達不了「單獨收回」，只能開通');
});

check('閘門有把登入帳號帶進判定（否則例外形同虛設）', () => {
  const mw = read('server/middlewares/requireResource.js');
  assert.ok(/userId: req\.adminUser\.sub/.test(mw),
    '只傳角色的話，為某個人單獨設定的權限完全不會生效');
  assert.ok(!/canAccess\(role,/.test(mw),
    '還在用只看角色的 canAccess，例外不會套用');
});

check('/mine 回實際生效的清單，不是角色預設', () => {
  const r = read('server/routes/admin/rolePermissions.js');
  assert.ok(/effectiveResources\(/.test(r),
    '選單若只反映角色預設，被單獨收回的人仍會看到入口，點進去才吃 403');
});

check('例外的寫入限管理員本人', () => {
  const r = read('server/routes/admin/rolePermissions.js');
  const m = r.match(/router\.put\('\/users\/:userId'[^\n]*/);
  assert.ok(m, '找不到 PUT /users/:userId');
  assert.ok(/requireAdminRole\('admin'\)/.test(m[0]),
    '否則被授權的人可以替自己開通任何頁面');
});

console.log(failures ? `\n${failures} FAILED` : '\nrole_permissions: ALL PASS');
process.exitCode = failures ? 1 : 0;

