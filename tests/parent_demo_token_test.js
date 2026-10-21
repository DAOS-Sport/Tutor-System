'use strict';
// 示範帳號（demo: 開頭的 LINE UID）的家長憑證只在開了 Demo 登入的非正式環境有效（2026-10-21）：
// Preview 與正式站可能共用 JWT_SECRET、家長 ID 也可能相同，Preview 發的示範憑證不能拿到正式站用。
const assert = require('assert');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'parent-demo-token-test-secret';
let dbCalls = 0;
const dbId = require.resolve('../server/models/db');
require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  exports: { pool: { query: async () => { dbCalls += 1; return { rowCount: 1, rows: [{}] }; } } },
};
const { signParentToken, requireParent, requireLiffUser, optionalParent } = require(path.join('..', 'server/middlewares/parentAuth'));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
function withEnv(env, fn) {
  const saved = { NODE_ENV: process.env.NODE_ENV, ALLOW_DEMO_LOGIN: process.env.ALLOW_DEMO_LOGIN };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
}
async function call(mw, lineUid) {
  const token = signParentToken({ parentId: '00000000-0000-0000-0000-000000000001', phone: '0900000000', lineUid });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const out = { status: 200, body: null, next: false, req };
  const res = { status(code) { out.status = code; return this; }, json(body) { out.body = body; return this; } };
  await mw(req, res, () => { out.next = true; });
  return out;
}

(async () => {
  await check('正式環境：示範憑證被 requireParent 擋下，不查資料庫', () => withEnv({ NODE_ENV: 'production', ALLOW_DEMO_LOGIN: undefined }, async () => {
    dbCalls = 0;
    const r = await call(requireParent, 'demo:register-abc');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'DEMO_TOKEN_NOT_ALLOWED');
    assert.strictEqual(r.next, false);
    assert.strictEqual(dbCalls, 0);
  }));
  await check('正式環境就算設了 ALLOW_DEMO_LOGIN：示範憑證照樣擋', () => withEnv({ NODE_ENV: 'production', ALLOW_DEMO_LOGIN: '1' }, async () => {
    assert.strictEqual((await call(requireParent, 'demo:0912345678')).status, 401);
  }));
  await check('正式環境：真實 LINE 帳號的憑證照常放行', () => withEnv({ NODE_ENV: 'production', ALLOW_DEMO_LOGIN: undefined }, async () => {
    const r = await call(requireParent, 'U0123456789abcdef0123456789abcdef');
    assert.strictEqual(r.next, true);
  }));
  await check('正式環境：沒帶 LINE 帳號的憑證照常放行', () => withEnv({ NODE_ENV: 'production', ALLOW_DEMO_LOGIN: undefined }, async () => {
    assert.strictEqual((await call(requireParent, null)).next, true);
  }));
  await check('開了 Demo 登入的非正式環境：示範憑證照常放行', () => withEnv({ NODE_ENV: 'development', ALLOW_DEMO_LOGIN: '1' }, async () => {
    assert.strictEqual((await call(requireParent, 'demo:register-abc')).next, true);
  }));
  await check('沒開 Demo 登入的非正式環境：示範憑證擋下', () => withEnv({ NODE_ENV: 'development', ALLOW_DEMO_LOGIN: undefined }, async () => {
    assert.strictEqual((await call(requireParent, 'demo:register-abc')).status, 401);
  }));
  await check('正式環境：requireLiffUser 也擋示範憑證', () => withEnv({ NODE_ENV: 'production', ALLOW_DEMO_LOGIN: undefined }, async () => {
    const r = await call(requireLiffUser, 'demo:register-abc');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.next, false);
  }));
  await check('正式環境：optionalParent 不把示範憑證當成家長', () => withEnv({ NODE_ENV: 'production', ALLOW_DEMO_LOGIN: undefined }, async () => {
    const r = await call(optionalParent, 'demo:register-abc');
    assert.strictEqual(r.next, true);
    assert.strictEqual(r.req.parent, undefined);
  }));

  if (failed) {
    console.error('\nparent_demo_token_test: ' + failed + ' failed');
    process.exit(1);
  }
  console.log('parent_demo_token_test: all passed');
})();
