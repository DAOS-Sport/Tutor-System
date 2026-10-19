/**
 * 角色權限 B 期（變更紀錄）與 C 期（動作層級權限）。
 *
 * B 期要防的是「權限改了、紀錄沒留」或「紀錄寫了、權限卻回滾」——
 * 所以這裡盯的是：紀錄跟權限在同一個交易、在 COMMIT 之前寫；沒有差異不寫空紀錄。
 *
 * C 期要防的是兩件事：
 *   1. 上線當天有人突然多了刪除權 —— 動作沒有預設角色，只有系統管理員能做
 *   2. 「藏起來但打得進去」—— 原本寫死 admin 的那幾支路由必須真的改掛 requireAction，
 *      前端按鈕也要讀同一份設定
 *
 * 不連資料庫：models/db 換成假的 pool，記錄每一句 SQL。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 假的資料庫 ───────────────────────────────────────────────────────
const DB = {
  role_permissions: [],            // { role, resource_key }
  overrides: [],                   // { user_id, resource_key, allowed }
  identities: [],                  // { user_id, role, is_counter, is_coach, is_lifeguard, manual_roles }
};
let LOG = [];
function answer(sql, args) {
  LOG.push(sql.replace(/\s+/g, ' ').trim());
  if (/SELECT role, resource_key FROM role_permissions/.test(sql)) return { rows: DB.role_permissions };
  if (/SELECT user_id, resource_key, allowed FROM user_permission_overrides/.test(sql)) return { rows: DB.overrides };
  if (/FROM admin_users u\s+JOIN admin_staff s/.test(sql)) return { rows: DB.identities };
  if (/SELECT resource_key FROM role_permissions WHERE role = \$1 FOR UPDATE/.test(sql)) {
    return { rows: DB.role_permissions.filter((r) => r.role === args[0]) };
  }
  if (/SELECT resource_key, allowed FROM user_permission_overrides WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
    return { rows: DB.overrides.filter((r) => r.user_id === args[0]) };
  }
  if (/AS label FROM admin_users/.test(sql)) return { rows: [{ label: '王小明' }] };
  if (/INSERT INTO permission_audit_log/.test(sql)) {
    LOG[LOG.length - 1] = { sql: 'AUDIT', args };
  }
  return { rows: [] };
}
const pool = {
  query: async (sql, args) => answer(sql, args),
  connect: async () => ({ query: async (sql, args) => answer(sql, args), release() {} }),
};
const dbPath = require.resolve(path.join(SERVER, 'models', 'db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool }, children: [] };

const svc = require(path.join(SERVER, 'services', 'rolePermissions'));
const audit = require(path.join(SERVER, 'services', 'permissionAudit'));
const {
  ADMIN_ACTIONS, ACTION_KEYS, RESOURCE_KEYS, isResourceKey,
} = require(path.join(SERVER, 'constants', 'adminResources'));

let failures = 0;
async function check(label, fn) {
  try { svc.invalidate(); LOG = []; await fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

(async () => {
  // ══ B 期：變更紀錄 ══════════════════════════════════════════════════
  await check('diff 只列有差異的項目，依代號排序', async () => {
    const d = audit.diff({ a: true, b: true }, { b: true, c: true });
    assert.deepStrictEqual(d, [{ key: 'a', from: true, to: null }, { key: 'c', from: null, to: true }]);
    assert.deepStrictEqual(audit.diff({ x: 'allow' }, { x: 'allow' }), []);
  });

  await check('改角色權限：紀錄與權限在同一個交易、COMMIT 之前寫入', async () => {
    DB.role_permissions = [{ role: 'staff', resource_key: 'reconcile' }, { role: 'staff', resource_key: 'refund' }];
    await svc.setRolePermissions('staff', ['reconcile', 'sessions'], { sub: 'U9', name: '管理員甲' });
    const iBegin = LOG.indexOf('BEGIN');
    const iAudit = LOG.findIndex((x) => x && x.sql === 'AUDIT');
    const iCommit = LOG.indexOf('COMMIT');
    assert.ok(iBegin >= 0 && iAudit > iBegin && iCommit > iAudit,
      `順序應為 BEGIN → 紀錄 → COMMIT，實際 ${iBegin} / ${iAudit} / ${iCommit}`);
    const [actorId, actorName, type, target, label, changes] = LOG[iAudit].args;
    assert.strictEqual(actorId, 'U9');
    assert.strictEqual(actorName, '管理員甲');
    assert.strictEqual(type, 'role');
    assert.strictEqual(target, 'staff');
    assert.strictEqual(label, '行政櫃檯');
    assert.deepStrictEqual(JSON.parse(changes), [
      { key: 'refund', from: true, to: null },
      { key: 'sessions', from: null, to: true },
    ]);
  });

  await check('按了儲存但沒改任何東西 → 不寫空紀錄', async () => {
    DB.role_permissions = [{ role: 'staff', resource_key: 'reconcile' }];
    await svc.setRolePermissions('staff', ['reconcile'], { sub: 'U9', name: '管理員甲' });
    assert.ok(!LOG.some((x) => x && x.sql === 'AUDIT'), '沒有差異卻留了一筆紀錄');
  });

  await check('改個人例外：記成 開通 / 收回 / 跟隨角色', async () => {
    DB.overrides = [{ user_id: 'U5', resource_key: 'refund', allowed: false }];
    await svc.setUserOverrides('U5', { refund: true, reports: false }, { sub: 'U9', name: '管理員甲' });
    const a = LOG.find((x) => x && x.sql === 'AUDIT');
    assert.ok(a, '沒有寫紀錄');
    assert.strictEqual(a.args[2], 'user');
    assert.strictEqual(a.args[4], '王小明');
    assert.deepStrictEqual(JSON.parse(a.args[5]), [
      { key: 'refund', from: 'deny', to: 'allow' },
      { key: 'reports', from: null, to: 'deny' },
    ]);
  });

  await check('舊呼叫端傳字串當操作者也記得下來', async () => {
    assert.deepStrictEqual(audit.actorOf('某人'), { id: null, name: '某人' });
  });

  await check('員工身分變更也留紀錄（加一個身分＝發出那一整欄的頁面）', async () => {
    const src = read('server/routes/admin/staff.js');
    const i = src.indexOf("targetType: 'staff_roles'");
    const j = src.indexOf("DELETE FROM admin_staff_roles WHERE staff_id = $1', [id]");
    assert.ok(i > 0 && j > i, '身分紀錄要在刪除舊身分之前、同一個交易裡寫');
  });

  await check('紀錄表只有讀取端點，看得到「角色權限管理」的人才看得到', async () => {
    const src = read('server/routes/admin/rolePermissions.js');
    assert.ok(/router\.get\('\/audit', requireAdminAuth, requireResource\('role-permissions'\)/.test(src));
    assert.ok(!/router\.(post|put|patch|delete)\('\/audit/.test(src), '紀錄不該能被改或刪');
    assert.ok(/'audit', '變更紀錄'/.test(read('client/admin/src/pages/RolePermissionsPage.jsx')),
      '角色權限管理頁沒有變更紀錄分頁');
  });

  await check('資料表定義', async () => {
    assert.ok(/CREATE TABLE IF NOT EXISTS permission_audit_log/.test(audit.SCHEMA_SQL));
    assert.ok(/permissionAudit'\)\.SCHEMA_SQL/.test(read('server/bootstrap/admin.js')), 'bootstrap 沒有建表');
  });

  // ══ C 期：動作層級權限 ══════════════════════════════════════════════
  await check('每個動作都掛在一個真實的頁面底下，代號是「頁面:動作」', async () => {
    assert.strictEqual(new Set(ACTION_KEYS).size, ACTION_KEYS.length, '動作代號重複');
    for (const a of ADMIN_ACTIONS) {
      assert.ok(isResourceKey(a.resource), `${a.key} 的頁面 ${a.resource} 不存在`);
      assert.ok(a.key.startsWith(a.resource + ':'), `${a.key} 應以 ${a.resource}: 開頭`);
      assert.ok(!RESOURCE_KEYS.includes(a.key), `${a.key} 跟頁面代號撞名`);
      assert.ok(!('defaultRoles' in a), `${a.key} 不可有預設角色：上線當天只有系統管理員能做`);
    }
  });

  await check('沒有設定時只有系統管理員能做（上線當天行為不變）', async () => {
    DB.role_permissions = [];
    DB.overrides = [];
    DB.identities = [];
    for (const k of ACTION_KEYS) {
      assert.strictEqual(await svc.canUserDo({ role: 'admin', userId: 'A' }, k), true);
      for (const r of ['manager', 'staff', 'lifeguard']) {
        assert.strictEqual(await svc.canUserDo({ role: r, userId: 'X' }, k), false, `${r} 不該能 ${k}`);
      }
    }
  });

  await check('開給角色之後生效；個人例外可以收回；教練永遠沒有', async () => {
    DB.role_permissions = [
      { role: 'manager', resource_key: 'ragic-z03:delete' },
      { role: 'coach', resource_key: 'ragic-z03:delete' },     // 舊資料殘留
    ];
    DB.overrides = [{ user_id: 'M2', resource_key: 'ragic-z03:delete', allowed: false }];
    assert.strictEqual(await svc.canUserDo({ role: 'manager', userId: 'M1' }, 'ragic-z03:delete'), true);
    assert.strictEqual(await svc.canUserDo({ role: 'manager', userId: 'M2' }, 'ragic-z03:delete'), false,
      '個人收回要壓過角色');
    assert.strictEqual(await svc.canUserDo({ role: 'coach', userId: 'C1' }, 'ragic-z03:delete'), false,
      '教練不走後台，殘留的列不該生效');
    assert.deepStrictEqual(await svc.effectiveActions({ role: 'manager', userId: 'M1' }), ['ragic-z03:delete']);
    assert.deepStrictEqual(await svc.effectiveActions({ role: 'manager', userId: 'M2' }), []);
  });

  await check('動作代號不會混進頁面清單（選單與「看得到幾頁」才不會失真）', async () => {
    DB.role_permissions = [{ role: 'manager', resource_key: 'ragic-z03:delete' }];
    DB.overrides = [{ user_id: 'M1', resource_key: 'tags:delete-category', allowed: true }];
    const pages = await svc.effectiveResources({ role: 'manager', userId: 'M1' });
    assert.ok(pages.every((k) => RESOURCE_KEYS.includes(k)), JSON.stringify(pages));
    assert.deepStrictEqual(await svc.effectiveResources({ role: 'admin', userId: 'A' }), [...RESOURCE_KEYS]);
  });

  await check('認不得的動作一律拒絕，連系統管理員也一樣（擋打錯字）', async () => {
    assert.strictEqual(await svc.canUserDo({ role: 'admin', userId: 'A' }, 'ragic-z03:nuke'), false);
    assert.strictEqual(await svc.canUserDo({ role: 'admin', userId: 'A' }, 'ragic-z03'), false,
      '頁面代號不能拿來當動作');
  });

  await check('角色設定與個人例外都收得下動作代號', async () => {
    DB.role_permissions = [];
    await svc.setRolePermissions('manager', ['ragic-z03', 'ragic-z03:delete'], 'x');
    await svc.setUserOverrides('M1', { 'tags:delete-category': true }, 'x');
    await assert.rejects(() => svc.setRolePermissions('manager', ['ragic-z03:nuke'], 'x'),
      (e) => e.code === 'UNKNOWN_RESOURCE');
  });

  await check('requireAction 收到未知代號在啟動時就炸', async () => {
    // eslint-disable-next-line global-require
    const { requireAction } = require(path.join(SERVER, 'middlewares', 'requireResource'));
    assert.throws(() => requireAction('ragic-z03:nuke'), /未知的動作代號/);
    assert.strictEqual(typeof requireAction('ragic-z03:delete'), 'function');
  });

  await check('requireAction：沒權限回 403、有權限 next()、讀不到設定一律拒絕', async () => {
    // eslint-disable-next-line global-require
    const { requireAction } = require(path.join(SERVER, 'middlewares', 'requireResource'));
    const gate = requireAction('ragic-z03:delete');
    const run = (user) => new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      };
      gate({ adminUser: user }, res, () => resolve({ status: 'next' }));
    });
    DB.role_permissions = [];
    DB.overrides = [];
    svc.invalidate();
    assert.strictEqual((await run({ role: 'staff', sub: 'S1' })).status, 403);
    assert.strictEqual((await run({ role: 'admin', sub: 'A1' })).status, 'next');
    const orig = pool.query;
    pool.query = async () => { throw new Error('db down'); };
    svc.invalidate();
    try {
      assert.strictEqual((await run({ role: 'staff', sub: 'S1' })).status, 403);
    } finally { pool.query = orig; }
  });

  await check('原本寫死 admin 的路由改掛 requireAction', async () => {
    const want = [
      ['server/routes/admin/learn.js', /router\.delete\('\/tag-categories\/:id', requireResource\('tags'\), requireAction\('tags:delete-category'\)/],
      ['server/routes/admin/ragicZ03.js', /router\.get\('\/review-archive\/preview', requireAction\('ragic-z03:review-archive'\)/],
      ['server/routes/admin/ragicZ03.js', /router\.post\('\/review-archive', requireAction\('ragic-z03:review-archive'\)/],
      ['server/routes/admin/ragicZ03.js', /router\.delete\('\/:id', requireAction\('ragic-z03:delete'\)/],
      ['server/routes/admin/families.js', /router\.post\('\/:id\/transfer-owner', requireAction\('customer-parents:transfer-owner'\)/],
      ['server/routes/admin/ragicStaging.js', /router\.use\(requireAction\('ragic-status:staging-review'\)\)/],
      ['server/routes/admin/ragicTimeline.js', /requireResource\('ragic-status'\), requireAction\('ragic-status:timeline'\)/],
    ];
    for (const [f, re] of want) assert.ok(re.test(read(f)), `${f} 沒有改掛 ${re}`);
    // 頁面閘門仍在檔案層（Z03 與家庭）：開了動作沒開頁面還是進不去。
    assert.ok(/router\.use\(requireResource\('ragic-z03'\)\)/.test(read('server/routes/admin/ragicZ03.js')));
    assert.ok(/router\.use\(requireAdminAuth, requireResource\('customer-parents'\)\)/.test(read('server/routes/admin/families.js')));
  });

  await check('前端按鈕讀同一份動作設定，不再看 isAdmin', async () => {
    const tags = read('client/admin/src/pages/TagsPage.jsx');
    assert.ok(/canDo\('tags:delete-category'\)/.test(tags));
    const z03 = read('client/admin/src/pages/RagicZ03Page.jsx');
    assert.ok(/canDo\('ragic-z03:review-archive'\)/.test(z03) && /canDo\('ragic-z03:delete'\)/.test(z03));
    assert.ok(!/isAdmin/.test(z03), 'RagicZ03Page 還在用 isAdmin');
    const fam = read('client/admin/src/components/FamilyPanel.jsx');
    assert.ok(/canDo\('customer-parents:transfer-owner'\)/.test(fam) && !/isAdmin/.test(fam));
    assert.ok(/action="ragic-status:staging-review"/.test(read('client/admin/src/App.jsx')));
  });

  await check('/mine 另外回動作清單，allowed 仍只放頁面', async () => {
    const src = read('server/routes/admin/rolePermissions.js');
    assert.ok(/res\.json\(\{ role, allowed, actions \}\)/.test(src));
  });

  await check('凍結區不收動作（簽到、手動扣課、扣課復活、手動建檔）', async () => {
    const frozen = ['checkin', 'checkin-modes', 'manual-deduction', 'revive', 'manual-enroll', 'sessions'];
    for (const a of ADMIN_ACTIONS) {
      assert.ok(!frozen.includes(a.resource), `${a.key} 落在凍結區，需先取得專案擁有者同意`);
    }
  });

  console.log(failures ? `\n${failures} FAILED` : '\npermission_audit_actions: ALL PASS');
  process.exitCode = failures ? 1 : 0;
})();
