'use strict';
// withTransaction（#35）：用假的 pool 記錄每一步，不連 DB。
const assert = require('node:assert/strict');
const { withTransaction } = require('../server/models/tx');

function fakePool({ failOn = {} } = {}) {
  const log = [];
  const client = {
    async query(sql) {
      log.push(sql);
      if (failOn[sql]) throw failOn[sql];
      return { rows: [] };
    },
    release() { log.push('release'); },
  };
  return { log, pool: { async connect() { log.push('connect'); return client; } } };
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok   ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

(async () => {
  await check('成功：BEGIN → fn → COMMIT → release，回傳 fn 的結果', async () => {
    const { log, pool } = fakePool();
    const out = await withTransaction(async (c) => { await c.query('SELECT 1'); return 42; }, pool);
    assert.equal(out, 42);
    assert.deepEqual(log, ['connect', 'BEGIN', 'SELECT 1', 'COMMIT', 'release']);
  });

  await check('fn 拋錯：ROLLBACK、丟出同一個錯誤、release', async () => {
    const { log, pool } = fakePool();
    const boom = new Error('業務錯誤');
    await assert.rejects(withTransaction(async () => { throw boom; }, pool), (e) => e === boom);
    assert.deepEqual(log, ['connect', 'BEGIN', 'ROLLBACK', 'release']);
  });

  await check('ROLLBACK 也失敗：仍丟出原錯誤、release', async () => {
    const { log, pool } = fakePool({ failOn: { ROLLBACK: new Error('連線已斷') } });
    const boom = new Error('業務錯誤');
    await assert.rejects(withTransaction(async () => { throw boom; }, pool), (e) => e === boom);
    assert.deepEqual(log, ['connect', 'BEGIN', 'ROLLBACK', 'release']);
  });

  await check('COMMIT 失敗：嘗試 ROLLBACK、丟出 COMMIT 的錯誤、release', async () => {
    const commitErr = new Error('COMMIT 失敗');
    const { log, pool } = fakePool({ failOn: { COMMIT: commitErr } });
    await assert.rejects(withTransaction(async () => 1, pool), (e) => e === commitErr);
    assert.deepEqual(log, ['connect', 'BEGIN', 'COMMIT', 'ROLLBACK', 'release']);
  });

  await check('BEGIN 失敗：不呼叫 fn、丟出錯誤、release', async () => {
    const beginErr = new Error('BEGIN 失敗');
    const { log, pool } = fakePool({ failOn: { BEGIN: beginErr } });
    let called = false;
    await assert.rejects(withTransaction(async () => { called = true; }, pool), (e) => e === beginErr);
    assert.equal(called, false);
    assert.deepEqual(log, ['connect', 'BEGIN', 'ROLLBACK', 'release']);
  });

  await check('取不到連線：直接丟錯，不呼叫 release', async () => {
    const connErr = new Error('pool 滿了');
    await assert.rejects(withTransaction(async () => 1, { async connect() { throw connErr; } }), (e) => e === connErr);
  });

  if (failures) { console.error(`with_transaction_test: ${failures} FAIL`); process.exit(1); }
  console.log('PASS withTransaction：成功 COMMIT、失敗 ROLLBACK 並丟原錯誤、一定歸還連線');
})();
