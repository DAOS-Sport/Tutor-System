'use strict';
// scripts/github-sync.js 端到端：在暫存目錄建一個「GitHub」bare repo 與一個歷史分開的「Replit」repo，
// 用合成資料跑 init → push → 未知個資擋下 → fake → pull → 衝突還原。不碰網路、不碰正式資料。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const TOOL = path.join(__dirname, '..', 'scripts', 'github-sync.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-sync-test-'));
const GHB = path.join(tmp, 'gh.git'), SEED = path.join(tmp, 'seed'), RP = path.join(tmp, 'rp'), OTHER = path.join(tmp, 'other');
const REAL = '0933444555', FAKE = '0900111222', TESTVAL = '0912000000', UNKNOWN = '0955666777';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
function repo(dir) { fs.mkdirSync(dir, { recursive: true }); g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.name', 't'); g(dir, 'config', 'user.email', 't@t'); }
function commit(dir, msg) { g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', msg); }
function tool(...args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: RP, encoding: 'utf8', env: { ...process.env, GITHUB_SYNC_ROOT: RP, GITHUB_SYNC_REMOTE: 'gh' } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const ghShow = (f) => g(GHB, 'show', `main:${f}`);
const ghTreeText = () => g(GHB, 'grep', '-I', '-h', '-e', '.', 'main', '--').toString();

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

try {
  // GitHub：去個資快照
  g(tmp, 'init', '-q', '--bare', '-b', 'main', GHB);
  repo(SEED);
  write(SEED, 'a.js', `const phone = '${FAKE}';\n`);
  write(SEED, 'b.js', `// 測試值 ${TESTVAL}\n`);
  write(SEED, 'server/public/admin/bundle.js', 'github-build\n');
  commit(SEED, 'gh initial'); g(SEED, 'remote', 'add', 'origin', GHB); g(SEED, 'push', '-q', 'origin', 'main');
  // Replit：歷史分開、含真值
  repo(RP);
  write(RP, 'a.js', `const phone = '${REAL}';\n`);
  write(RP, 'b.js', `// 測試值 ${TESTVAL}\n`);
  write(RP, 'server/public/admin/bundle.js', 'replit-build\n');
  write(RP, 'outputs/private.txt', `${REAL}\n`);
  write(RP, '.gitignore', '.local/github-sync/\n');
  commit(RP, 'replit initial'); g(RP, 'remote', 'add', 'gh', GHB);

  check('init：推出真值↔假值對照與允許的測試值', () => {
    const r = tool('init');
    assert.equal(r.code, 0, r.out);
    const map = JSON.parse(read(RP, '.local/github-sync/pii-map.json'));
    const allow = JSON.parse(read(RP, '.local/github-sync/allow.json'));
    assert.deepEqual(map, { [REAL]: FAKE });
    assert.deepEqual(allow, [TESTVAL]);
  });

  check('push：Replit 的改動去個資後推上 GitHub，打包檔與 outputs 不動', () => {
    write(RP, 'a.js', `const phone = '${REAL}';\nconst other = 2;\n`);
    commit(RP, 'replit edit');
    const r = tool('push');
    assert.equal(r.code, 0, r.out);
    assert.equal(ghShow('a.js'), `const phone = '${FAKE}';\nconst other = 2;`);
    assert.equal(ghShow('server/public/admin/bundle.js'), 'github-build');
    assert.throws(() => ghShow('outputs/private.txt'));
    assert.ok(!ghTreeText().includes(REAL), 'GitHub 出現真值');
  });

  check('push：出現沒看過的電話就不推，GitHub 不變', () => {
    const before = g(GHB, 'rev-parse', 'main');
    write(RP, 'c.js', `const x = '${UNKNOWN}';\n`);
    commit(RP, 'add unknown');
    const r = tool('push');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /c\.js:1/);
    assert.ok(!r.out.includes(UNKNOWN), '輸出不可印出完整值');
    assert.equal(g(GHB, 'rev-parse', 'main'), before);
  });

  check('fake 之後再 push：以假值推上去，真值不外流', () => {
    assert.equal(tool('fake', 'c.js:1').code, 0);
    const r = tool('push');
    assert.equal(r.code, 0, r.out);
    const c = ghShow('c.js');
    assert.ok(!c.includes(UNKNOWN) && /0900\d{6}/.test(c), c);
    assert.ok(!ghTreeText().includes(UNKNOWN) && !ghTreeText().includes(REAL));
  });

  check('真值對照檔不會被 git 追蹤（Replit 發布時的自動 commit 也收不進去）', () => {
    assert.equal(g(RP, 'ls-files', '.local'), '');
    assert.equal(g(RP, 'check-ignore', '.local/github-sync/pii-map.json'), '.local/github-sync/pii-map.json');
  });

  check('GitHub 有新改動時 push 會要求先 pull', () => {
    g(tmp, 'clone', '-q', GHB, OTHER); g(OTHER, 'config', 'user.name', 'o'); g(OTHER, 'config', 'user.email', 'o@o');
    write(OTHER, 'a.js', `const phone = '${FAKE}';\nconst other = 3;\n`);
    commit(OTHER, 'cloud edit'); g(OTHER, 'push', '-q', 'origin', 'main');
    write(RP, 'd.js', 'const d = 1;\n'); commit(RP, 'replit d');
    const r = tool('push');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /先跑 pull/);
  });

  check('pull：GitHub 的改動套回 Replit，假值換回真值，pull 的 commit 不會再被推回去', () => {
    const r = tool('pull', '--no-test');
    assert.equal(r.code, 0, r.out);
    assert.equal(read(RP, 'a.js'), `const phone = '${REAL}';\nconst other = 3;\n`);
    assert.match(g(RP, 'log', '-1', '--format=%B'), /GitHub-Sync-Pull:/);
    const s = tool('status');
    assert.match(s.out, /改過 1 個檔案/, s.out);
    assert.match(s.out, /d\.js/);
  });

  check('sync：推上 Replit 自己的改動（d.js），GitHub 上的 a.js 維持假值', () => {
    const r = tool('sync', '--no-test');
    assert.equal(r.code, 0, r.out);
    assert.equal(ghShow('d.js'), 'const d = 1;');
    assert.equal(ghShow('a.js'), `const phone = '${FAKE}';\nconst other = 3;`);
    assert.match(tool('status').out, /改過 0 個檔案/);
  });

  check('pull 遇到兩邊改同一行：自動還原，Replit 不留任何改動', () => {
    g(OTHER, 'pull', '-q', '--rebase'); write(OTHER, 'b.js', '// cloud\n'); commit(OTHER, 'cloud b'); g(OTHER, 'push', '-q', 'origin', 'main');
    write(RP, 'b.js', '// replit\n'); commit(RP, 'replit b');
    const head = g(RP, 'rev-parse', 'HEAD');
    const r = tool('pull', '--no-test');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /衝突/);
    assert.equal(g(RP, 'rev-parse', 'HEAD'), head);
    assert.equal(g(RP, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(read(RP, 'b.js'), '// replit\n');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) { console.error(`github_sync_test: ${failures} FAIL`); process.exit(1); }
console.log('PASS github-sync：init／push／未知個資擋下／pull／sync／衝突還原，GitHub 從未出現真值');
