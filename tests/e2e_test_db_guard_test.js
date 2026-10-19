'use strict';
// e2e 只能連 TEST_DATABASE_URL：用兩個假的資料庫埠（「正式庫」與「測試庫」）
// 記錄連線，證明拒絕時沒有任何連線、通過時子行程拿到的是測試庫。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUN_ALL = path.join(ROOT, 'tests/e2e/run_all.js');
const ACCOUNTS = path.join(ROOT, 'tests/e2e/_accounts.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-db-guard-'));

function fakeDb() {
  const db = { hits: 0 };
  db.server = net.createServer((sock) => { db.hits += 1; sock.destroy(); });
  return new Promise((resolve) => db.server.listen(0, '127.0.0.1', () => {
    db.url = `postgres://e2e:e2e@127.0.0.1:${db.server.address().port}/e2e`;
    resolve(db);
  }));
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { PATH: process.env.PATH, E2E_TOKEN_CACHE: path.join(TMP, 'tokens.json'), ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

// 攔截 run_all.js 的 spawnSync：只記錄要傳給子行程的 DATABASE_URL，不真的跑 e2e。
const HOOK = path.join(TMP, 'capture-spawn.js');
const CAPTURE = path.join(TMP, 'child-env.jsonl');
fs.writeFileSync(HOOK, `
const cp = require('child_process');
cp.spawnSync = (cmd, args, opts) => {
  require('fs').appendFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({ file: args[0], db: (opts.env || process.env).DATABASE_URL }) + '\\n');
  return { status: 0 };
};
`);

(async () => {
  const prod = await fakeDb();
  const test = await fakeDb();
  try {
    // 1. 只設 DATABASE_URL：runner 拒絕、非 0、沒有任何連線、沒有啟動子行程
    const onlyProd = await run(['--require', HOOK, RUN_ALL], { DATABASE_URL: prod.url });
    assert.notEqual(onlyProd.code, 0, '只設 DATABASE_URL 時 runner 必須非 0 結束');
    assert.match(onlyProd.out, /TEST_DATABASE_URL/);
    assert.equal(fs.existsSync(CAPTURE), false, '拒絕時不可啟動任何子行程');

    // 2. 兩者相同：拒絕
    const same = await run(['--require', HOOK, RUN_ALL], { DATABASE_URL: prod.url, TEST_DATABASE_URL: prod.url });
    assert.notEqual(same.code, 0, 'TEST_DATABASE_URL 與 DATABASE_URL 相同必須拒絕');
    assert.match(same.out, /相同/);
    assert.equal(fs.existsSync(CAPTURE), false);

    // 3. 設了不同的 TEST_DATABASE_URL：每個子行程拿到的 DATABASE_URL 都是測試庫
    const ok = await run(['--require', HOOK, RUN_ALL], { DATABASE_URL: prod.url, TEST_DATABASE_URL: test.url });
    assert.equal(ok.code, 0, ok.out);
    const children = fs.readFileSync(CAPTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(children.length >= 30, `應啟動全部 e2e 路徑，實際 ${children.length}`);
    for (const c of children) assert.equal(c.db, test.url, `${path.basename(c.file)} 拿到的不是測試庫`);

    // 4. 單獨跑用到 _accounts 的路徑：只設 DATABASE_URL 也要在連線前拒絕；設了測試庫就只連測試庫
    const callAccounts = ['-e', `require(${JSON.stringify(ACCOUNTS)}).withAdminAccount({ username: 'g', password: 'g', role: 'manager' }, async () => {}).catch(() => process.exit(3))`];
    const accProd = await run(callAccounts, { DATABASE_URL: prod.url });
    assert.equal(accProd.code, 1, '_accounts 只設 DATABASE_URL 必須拒絕');
    const accSame = await run(callAccounts, { DATABASE_URL: prod.url, TEST_DATABASE_URL: prod.url });
    assert.equal(accSame.code, 1, '_accounts 兩者相同必須拒絕');
    const accTest = await run(callAccounts, { DATABASE_URL: prod.url, TEST_DATABASE_URL: test.url });
    assert.equal(accTest.code, 3, '設了測試庫時會去連（假 DB 立刻斷線，所以以錯誤結束）');
    assert.ok(test.hits >= 1, '_accounts 應該連到測試庫');

    assert.equal(prod.hits, 0, '「正式庫」一次都不可以被連到');
    console.log('PASS e2e 只連 TEST_DATABASE_URL：缺或相同即拒絕且零連線，子行程 DATABASE_URL＝測試庫');
  } finally {
    prod.server.close();
    test.server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
