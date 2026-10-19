/**
 * 角色權限 A 期：後台登入憑證要能「立即」失效。
 *
 * 在此之前 requireAdminAuth 只驗簽章，憑證效期 7 天。停用、降級、改場館、
 * 改密碼都要等 7 天才生效 —— 而且被降級的系統管理員在那 7 天裡仍然全開。
 * 這支直接呼叫 services/adminSession 的 checkToken，餵各種「憑證 vs 資料庫現況」
 * 的組合，驗它判得對。
 *
 * 不連資料庫：models/db 換成假的 pool，只回這支測試指定的那一列。
 * 身分重算用的是真的 routes/admin/auth.js 的 _effectiveLoginUser ——
 * 跟登入是同一個函式，這正是要驗的：登入發的憑證，下一次請求不能被自己踢掉。
 * （環境沒裝 express / bcryptjs / jsonwebtoken 時用最小替身，只為了讓模組載得起來；
 *  那三個套件跟這裡要驗的判定無關。）
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 只在套件不存在時補替身 ─────────────────────────────────────────────
const STUBS = {
  express: Object.assign(() => ({}), {
    Router: () => {
      const r = {};
      for (const m of ['get', 'post', 'put', 'patch', 'delete', 'use']) r[m] = () => r;
      return r;
    },
    json: () => () => {},
  }),
  bcryptjs: { compare: async () => false, hash: async () => 'x' },
  jsonwebtoken: {
    sign: (p) => Buffer.from(JSON.stringify(p)).toString('base64'),
    verify: (t) => JSON.parse(Buffer.from(t, 'base64').toString('utf8')),
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  try { return origResolve.call(this, request, parent, ...rest); } catch (e) {
    if (!STUBS[request]) throw e;
    const id = `__stub__/${request}`;
    require.cache[id] = { id, filename: id, loaded: true, exports: STUBS[request], children: [] };
    return id;
  }
};

// ── 假的資料庫：snapshot 查詢回 ROW ───────────────────────────────────
let ROW = null;
let QUERIES = 0;
let FAIL_DB = false;
const pool = {
  query: async (sql) => {
    QUERIES++;
    if (FAIL_DB) throw new Error('db down');
    if (/FROM admin_users u/.test(sql)) return { rows: ROW ? [ROW] : [] };
    return { rows: [] };
  },
};
const dbPath = require.resolve(path.join(SERVER, 'models', 'db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool }, children: [] };

const session = require(path.join(SERVER, 'services', 'adminSession'));

let failures = 0;
async function check(label, fn) {
  try { session.invalidate(); FAIL_DB = false; await fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

// 一位場館主管：沒有連 admin_staff 的內建帳號最單純，身分只看 admin_users.role。
function managerRow(over = {}) {
  return {
    id: 'U1', username: 'm1', name: '主管', role: 'manager', venue_id: 'V1',
    is_active: true, auth_version: 1, staff_id: null, staff_role: null,
    is_counter: false, is_coach: false, is_lifeguard: false, manual_roles: [],
    venue_ids: ['V1'], ...over,
  };
}
const token = (over = {}) => ({ sub: 'U1', role: 'manager', venue_ids: ['V1'], av: 1, ...over });

(async () => {
  await check('現況與憑證一致 → 放行', async () => {
    ROW = managerRow();
    assert.strictEqual(await session.checkToken(token()), null);
  });

  await check('帳號被停用 → ACCOUNT_DISABLED（不用等 7 天）', async () => {
    ROW = managerRow({ is_active: false });
    const r = await session.checkToken(token());
    assert.strictEqual(r && r.code, 'ACCOUNT_DISABLED');
  });

  await check('改過密碼（auth_version 前進）→ 舊憑證 SESSION_REVOKED', async () => {
    ROW = managerRow({ auth_version: 2 });
    const r = await session.checkToken(token({ av: 1 }));
    assert.strictEqual(r && r.code, 'SESSION_REVOKED');
  });

  await check('改版前發的憑證（沒有 av）視為版本 1：上線當下不會把所有人踢出去', async () => {
    ROW = managerRow();
    const legacy = token();
    delete legacy.av;
    assert.strictEqual(await session.checkToken(legacy), null);
    session.invalidate();
    ROW = managerRow({ auth_version: 3 });
    const r = await session.checkToken(legacy);
    assert.strictEqual(r && r.code, 'SESSION_REVOKED', '改過密碼之後舊式憑證也要失效');
  });

  await check('系統管理員被降成主管 → 憑證上的 admin 立即失效', async () => {
    ROW = managerRow();
    const r = await session.checkToken(token({ role: 'admin', venue_ids: [] }));
    assert.strictEqual(r && r.code, 'SESSION_STALE',
      '否則 rolePermissions 會把憑證上的 admin 當成一個身分，7 天內仍然全開');
  });

  await check('負責場館被改掉 → SESSION_STALE（不能再看舊場館的資料）', async () => {
    ROW = managerRow({ venue_ids: ['V2'], venue_id: 'V2' });
    const r = await session.checkToken(token());
    assert.strictEqual(r && r.code, 'SESSION_STALE');
  });

  await check('場館順序不同不算改動', async () => {
    ROW = managerRow({ venue_ids: ['V2', 'V1'] });
    assert.strictEqual(await session.checkToken(token({ venue_ids: ['V1', 'V2'] })), null);
  });

  await check('系統管理員不比對場館（他本來就看全部）', async () => {
    ROW = managerRow({ role: 'admin', venue_ids: ['V9'] });
    assert.strictEqual(await session.checkToken(token({ role: 'admin', venue_ids: [] })), null);
  });

  await check('救生員走員工身分推導：登入算出來的角色，下一次請求不會被自己踢掉', async () => {
    // 純救生員：admin_staff.role 是保底值 staff，Ragic 標 is_lifeguard。
    ROW = managerRow({
      role: 'lifeguard', staff_id: 'S1', staff_role: 'staff', is_lifeguard: true,
    });
    assert.strictEqual(await session.checkToken(token({ role: 'lifeguard' })), null);
    session.invalidate();
    // 同一個人憑證若寫著 staff（舊 bug 造成的保底值），要被擋下來重新登入。
    const r = await session.checkToken(token({ role: 'staff' }));
    assert.strictEqual(r && r.code, 'SESSION_STALE');
  });

  await check('帳號已刪除：綁定版本的憑證一律拒絕', async () => {
    ROW = null;
    const r = await session.checkToken(token());
    assert.strictEqual(r && r.code, 'SESSION_INVALID');
  });

  await check('快照有快取，invalidate 後重新查', async () => {
    ROW = managerRow();
    QUERIES = 0;
    await session.checkToken(token());
    await session.checkToken(token());
    assert.strictEqual(QUERIES, 1, `30 秒內第二次不該再查資料庫，實際查了 ${QUERIES} 次`);
    session.invalidate('U1');
    await session.checkToken(token());
    assert.strictEqual(QUERIES, 2, 'invalidate 之後要重新讀');
  });

  await check('資料庫讀不到時 throw（由 middleware 回 503），不能當成憑證無效', async () => {
    FAIL_DB = true;
    await assert.rejects(() => session.checkToken(token()));
  });

  // ── 真的走一次 middleware ─────────────────────────────────────────
  const { signToken, requireAdminAuth } = require(path.join(SERVER, 'middlewares', 'adminAuth'));
  function run(tok) {
    return new Promise((resolve) => {
      const req = { headers: { authorization: 'Bearer ' + signToken(tok) } };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      };
      requireAdminAuth(req, res, () => resolve({ status: 'next', user: req.adminUser }));
    });
  }

  await check('middleware：現況一致 → next()', async () => {
    ROW = managerRow();
    const r = await run(token());
    assert.strictEqual(r.status, 'next');
    assert.strictEqual(r.user.sub, 'U1');
  });

  await check('middleware：停用 → 401 ACCOUNT_DISABLED', async () => {
    ROW = managerRow({ is_active: false });
    const r = await run(token());
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'ACCOUNT_DISABLED');
  });

  await check('middleware：資料庫錯誤 → 503，不是 401', async () => {
    ROW = managerRow();
    FAIL_DB = true;
    const r = await run(token());
    assert.strictEqual(r.status, 503);
  });

  // ── 接線：各處有沒有真的用上 ───────────────────────────────────────
  await check('requireAdminAuth 每次請求都比對；資料庫錯誤回 503 而不是 401', async () => {
    const src = read('server/middlewares/adminAuth.js');
    assert.ok(/checkSession\(req\.adminUser\)/.test(src), 'requireAdminAuth 沒有呼叫 checkSession');
    assert.ok(/status\(503\)/.test(src) && /AUTH_CHECK_UNAVAILABLE/.test(src),
      '401 會讓前端把人登出 —— 資料庫抖一下就踢掉整間公司');
  });

  await check('登入時把 auth_version 簽進憑證（av）', async () => {
    const src = read('server/routes/admin/auth.js');
    const m = src.match(/async function _issueLogin[\s\S]*?\n}/);
    assert.ok(m && /av:/.test(m[0]), '_issueLogin 沒有簽 av');
    assert.ok(/adminSession\.snapshot\(/.test(m[0]),
      '場館與版本要取自比對用的同一份快照，否則登入後立刻被判成「場館已調整」');
  });

  await check('自己改密碼：版本 +1、換發新憑證、前端存起來', async () => {
    const src = read('server/routes/admin/auth.js');
    const m = src.match(/router\.post\('\/change-password'[\s\S]*?\n}\);/);
    assert.ok(m && /auth_version = COALESCE\(auth_version, 1\) \+ 1/.test(m[0]), '改密碼沒有讓舊憑證失效');
    assert.ok(/token \}\);/.test(m[0]), '改密碼沒有換發新憑證，這台裝置會被自己踢出去');
    for (const f of ['client/admin/src/components/AppLayout.jsx', 'client/admin/src/components/Header.jsx']) {
      assert.ok(/token: result\.token \|\| user\.token/.test(read(f)), `${f} 沒有存新憑證`);
    }
  });

  await check('管理員重設別人的密碼：版本 +1', async () => {
    const src = read('server/routes/admin/staff.js');
    const m = src.match(/router\.post\('\/:id\/reset-password'[\s\S]*?\n}\);/);
    assert.ok(m && /auth_version = COALESCE\(auth_version, 1\) \+ 1/.test(m[0]));
  });

  await check('員工管理的任何寫入都清掉登入狀態快取', async () => {
    const src = read('server/routes/admin/staff.js');
    assert.ok(/res\.on\('finish', \(\) => adminSession\.invalidate\(\)\)/.test(src));
  });

  await check('即時通知（WebSocket）也用同一套比對', async () => {
    const src = read('server/services/websocket.js');
    assert.ok((src.match(/_adminSessionOk\(payload\)/g) || []).length >= 2,
      '後台 WebSocket 的兩個入口都要擋舊憑證');
  });

  await check('資料表有 auth_version 欄位', async () => {
    const src = read('server/bootstrap/admin.js');
    assert.ok(/ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1/.test(src));
  });

  console.log(failures ? `\n${failures} FAILED` : '\nadmin_session_revocation: ALL PASS');
  process.exitCode = failures ? 1 : 0;
})();
