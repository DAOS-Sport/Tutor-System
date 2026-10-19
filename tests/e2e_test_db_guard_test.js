'use strict';
// e2e 只能連 TEST_DATABASE_URL：用兩個假的資料庫埠（「正式庫」與「測試庫」）記錄連線，
// 證明拒絕時沒有任何連線；通過時 run_all 自己起的 server 與每個子行程都拿到測試庫。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUN_ALL = path.join(ROOT, 'tests/e2e/run_all.js');
const LIB = path.join(ROOT, 'tests/e2e/_lib.js');
const ACCOUNTS = path.join(ROOT, 'tests/e2e/_accounts.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-db-guard-'));

function fakeDb() {
  const db = { hits: 0 };
  db.server = net.createServer((sock) => { db.hits += 1; sock.destroy(); });
  return new Promise((resolve) => db.server.listen(0, '127.0.0.1', () => {
    db.port = db.server.address().port;
    db.url = `postgres://e2e:e2e@127.0.0.1:${db.port}/e2e_test`;
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

// 攔截 run_all.js 的子行程：spawn（測試 server）改成在指定埠回 /health 200 的假 server，
// spawnSync（各路徑）只記錄環境變數，都不真的執行。
const HOOK = path.join(TMP, 'capture.js');
const CAPTURE = path.join(TMP, 'capture.jsonl');
fs.writeFileSync(HOOK, `
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const { EventEmitter } = require('events');
const log = (o) => fs.appendFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify(o) + '\\n');
cp.spawn = (cmd, args, opts) => {
  const e = opts.env;
  log({ kind: 'server', db: e.DATABASE_URL, safe: e.PREVIEW_SAFE_MODE, storage: e.OBJECT_STORAGE_DRIVER,
        ragic: e.RAGIC_API_KEY || null, nodeEnv: e.NODE_ENV || null, port: e.PORT });
  const srv = http.createServer((q, r) => { r.writeHead(q.url === '/health' ? 200 : 404); r.end('ok'); }).listen(Number(e.PORT), '127.0.0.1');
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { log({ kind: 'server-stopped' }); srv.close(); child.exitCode = 0; };
  return child;
};
cp.spawnSync = (cmd, args, opts) => {
  log({ kind: 'path', file: args[0], db: opts.env.DATABASE_URL, base: opts.env.BASE_URL });
  return { status: 0 };
};
`);
const captured = () => (fs.existsSync(CAPTURE) ? fs.readFileSync(CAPTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const reset = () => fs.rmSync(CAPTURE, { force: true });

(async () => {
  const prod = await fakeDb();
  const test = await fakeDb();
  const refused = async (label, args, env, pattern) => {
    reset();
    const r = await run(args, env);
    assert.notEqual(r.code, 0, `${label}：必須非 0 結束`);
    if (pattern) assert.match(r.out, pattern, label);
    assert.deepEqual(captured(), [], `${label}：不可啟動任何 server 或子行程`);
  };
  try {
    const hooked = ['--require', HOOK, RUN_ALL];
    await refused('只設 DATABASE_URL', hooked, { DATABASE_URL: prod.url }, /TEST_DATABASE_URL/);
    await refused('兩者字串相同', hooked, { DATABASE_URL: prod.url, TEST_DATABASE_URL: prod.url }, /同一個資料庫/);
    // 同一個庫的不同寫法：postgresql://、不同帳密、查詢參數、localhost
    const sameDbOtherSpelling = `postgresql://someone:else@localhost:${prod.port}/e2e_test?sslmode=disable`;
    await refused('同一個庫的不同寫法', hooked, { DATABASE_URL: prod.url, TEST_DATABASE_URL: sameDbOtherSpelling }, /同一個資料庫/);
    await refused('TEST_DATABASE_URL 無法解析', hooked, { DATABASE_URL: prod.url, TEST_DATABASE_URL: 'not a url' }, /無法解析/);
    await refused('BASE_URL 指向無法確認的 server', hooked,
      { DATABASE_URL: prod.url, TEST_DATABASE_URL: test.url, BASE_URL: 'http://127.0.0.1:3000' }, /E2E_EXTERNAL_SERVER=1/);

    // 正常：run_all 自己用測試庫起 server（安全模式），每個子行程拿到測試庫與那台 server
    reset();
    const ok = await run(hooked, { DATABASE_URL: prod.url, TEST_DATABASE_URL: test.url, RAGIC_API_KEY: 'should-be-removed', NODE_ENV: 'production' });
    assert.equal(ok.code, 0, ok.out);
    const events = captured();
    const server = events.find((e) => e.kind === 'server');
    assert.deepEqual({ db: server.db, safe: server.safe, storage: server.storage, ragic: server.ragic, nodeEnv: server.nodeEnv },
      { db: test.url, safe: '1', storage: 'local', ragic: null, nodeEnv: null }, '測試 server 必須連測試庫且關掉對外副作用');
    const paths = events.filter((e) => e.kind === 'path');
    assert.ok(paths.length >= 30, `應啟動全部 e2e 路徑，實際 ${paths.length}`);
    for (const p of paths) {
      assert.equal(p.db, test.url, `${path.basename(p.file)} 拿到的不是測試庫`);
      assert.equal(p.base, `http://127.0.0.1:${server.port}`, `${path.basename(p.file)} 沒有打測試 server`);
    }
    assert.equal(events[events.length - 1].kind, 'server-stopped', '跑完要關掉測試 server');

    // 明確聲明既有 server 連測試庫時，才允許沿用 BASE_URL（不另起 server）
    reset();
    const ext = await run(hooked, { DATABASE_URL: prod.url, TEST_DATABASE_URL: test.url, BASE_URL: 'http://127.0.0.1:3999', E2E_EXTERNAL_SERVER: '1' });
    assert.equal(ext.code, 0, ext.out);
    assert.equal(captured().filter((e) => e.kind === 'server').length, 0);
    assert.ok(captured().every((e) => e.base === 'http://127.0.0.1:3999' && e.db === test.url));

    // 單獨執行路徑檔（載入 _lib）：同樣只連測試庫，且要聲明 server
    const loadLib = ['-e', `require(${JSON.stringify(LIB)}); console.log('DB=' + process.env.DATABASE_URL)`];
    assert.notEqual((await run(loadLib, { DATABASE_URL: prod.url })).code, 0, '單獨執行只設 DATABASE_URL 必須拒絕');
    assert.notEqual((await run(loadLib, { DATABASE_URL: prod.url, TEST_DATABASE_URL: test.url })).code, 0, '單獨執行沒聲明 server 必須拒絕');
    const single = await run(loadLib, { DATABASE_URL: prod.url, TEST_DATABASE_URL: test.url, E2E_EXTERNAL_SERVER: '1' });
    assert.equal(single.code, 0, single.out);
    assert.match(single.out, new RegExp(`DB=${test.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '載入 _lib 後 DATABASE_URL 要換成測試庫');

    // _accounts：拒絕時零連線；設了測試庫只連測試庫
    const callAccounts = ['-e', `require(${JSON.stringify(ACCOUNTS)}).withAdminAccount({ username: 'g', password: 'g', role: 'manager' }, async () => {}).catch(() => process.exit(3))`];
    assert.equal((await run(callAccounts, { DATABASE_URL: prod.url })).code, 1);
    assert.equal((await run(callAccounts, { DATABASE_URL: prod.url, TEST_DATABASE_URL: prod.url })).code, 1);
    assert.equal((await run(callAccounts, { DATABASE_URL: prod.url, TEST_DATABASE_URL: test.url })).code, 3);
    assert.ok(test.hits >= 1, '_accounts 應該連到測試庫');

    assert.equal(prod.hits, 0, '「正式庫」一次都不可以被連到');
    console.log('PASS e2e 只連 TEST_DATABASE_URL：缺／同庫／無法確認 server 即拒絕且零連線；run_all 自己用測試庫起 server');
  } finally {
    prod.server.close();
    test.server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
