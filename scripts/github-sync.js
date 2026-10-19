#!/usr/bin/env node
'use strict';
/**
 * Replit ⇄ GitHub 程式碼同步（在 Replit 工作區的 Shell 執行；不放進建置流程，避免影響發布）
 *
 * GitHub（公開 repo）是去個資快照，Replit 是正式站的發布來源，兩邊的 git 歷史刻意分開，
 * 不能直接 pull／push。這支工具以「上次同步的一對 commit」為基準，只搬基準之後改過的檔案：
 *
 *   node scripts/github-sync.js status          看兩邊各有多少待同步
 *   node scripts/github-sync.js pull            GitHub 的改動以 patch 套進 Replit（假值換回真值）→ 跑 unit → commit
 *   node scripts/github-sync.js push [--dry-run] Replit 改過的檔案去個資 → 疊在 GitHub main 上 → fast-forward 推送
 *   node scripts/github-sync.js sync            pull 再 push；做完再按 Publish
 *   node scripts/github-sync.js init            第一次使用：從目前兩邊的內容推出真值↔假值對照
 *   node scripts/github-sync.js allow|fake <檔案>:<行>   push 遇到沒看過的個資時，標記為「可公開的測試值」或「換成假值」
 *
 * 真值↔假值對照與允許清單放在 .local/github-sync/（不進 git、不推 GitHub）。
 * 任何一步不確定就停：推送前若出現沒看過的電話／身分證／LINE UID／Email，或真值出現在要推的內容裡，一律不推。
 * 前端打包檔（server/public/admin、liff）與 outputs 等目錄不同步，發布時會重建。
 */
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.GITHUB_SYNC_ROOT || execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
const REMOTE = process.env.GITHUB_SYNC_REMOTE || 'subrepl-4yilphiu';
const BRANCH = 'main';
const GH = `${REMOTE}/${BRANCH}`;
const DATA = path.join(ROOT, '.local', 'github-sync');
const REF_GH = 'refs/github-sync/github';
const REF_RP = 'refs/github-sync/replit';
const PULL_TRAILER = 'GitHub-Sync-Pull:';
// 不同步：快照刻意排除的目錄、私有資料、前端打包檔（GitHub 端保留它自己的版本）
// 根目錄有些舊備份的檔名直接含反斜線（例如 outputs\two-specs-…\backup-before-FilterBar.jsx），也要排除。
const EXCLUDE = /^(outputs|artifacts|attached_assets|\.tmp|\.local|reports)(\/|\\|$)|^server\/public\/(admin|liff)\//;
const PII = /(?<![0-9])(?:\+?886[- ]?0?|0)9\d{2}[- ]?\d{3}[- ]?\d{3}(?![0-9])|(?<![A-Za-z0-9])[A-Z][12]\d{8}(?![0-9])|(?<![0-9A-Za-z])U[0-9a-f]{32}(?![0-9a-f])|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 30, ...opts });
}
const gitStr = (args, opts) => git(args, opts).toString().trim();
const readRef = (ref) => { try { return gitStr(['rev-parse', '--verify', '-q', ref]); } catch { return null; } };
const isText = (buf) => !buf.subarray(0, 8000).includes(0);
const mask = (v) => (v.length <= 4 ? '****' : v.slice(0, 2) + '*'.repeat(v.length - 4) + v.slice(-2));

function loadData() {
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
  return { map: read('pii-map.json', {}), allow: new Set(read('allow.json', [])) };
}
function saveData({ map, allow }) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'pii-map.json'), JSON.stringify(map, null, 1));
  fs.writeFileSync(path.join(DATA, 'allow.json'), JSON.stringify([...allow].sort(), null, 1));
}

function candidates(text) {
  return [...text.matchAll(PII)].map((m) => ({ value: m[0], index: m.index }));
}

// 真值換假值；回傳 { text, unknown: [{value, line}] }
function scrub(text, { map, allow }) {
  const fakes = new Set(Object.values(map));
  const unknown = [];
  const out = text.replace(PII, (v, idx) => {
    if (Object.hasOwn(map, v)) return map[v];
    if (!allow.has(v) && !fakes.has(v)) unknown.push({ value: v, line: text.slice(0, idx).split('\n').length });
    return v;
  });
  return { text: out, unknown };
}

// 假值換回真值（GitHub → Replit）
function unscrub(text, { map }) {
  const reverse = new Map(Object.entries(map).map(([real, fake]) => [fake, real]));
  return text.replace(PII, (v) => (reverse.has(v) ? reverse.get(v) : v));
}

// 同一個檔案的 Replit 版與 GitHub 版若只差在個資，逐一對應出 真值→假值
function alignPair(replitText, githubText) {
  const a = candidates(replitText), b = candidates(githubText);
  if (a.length !== b.length || replitText.replace(PII, '§') !== githubText.replace(PII, '§')) return null;
  return a.map((x, i) => [x.value, b[i].value]);
}

function fetchRemote() {
  git(['fetch', '-q', REMOTE, BRANCH]);
  return gitStr(['rev-parse', GH]);
}
function requireClean() {
  const dirty = gitStr(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error('工作區有未提交的改動，先 commit 或還原再同步。');
}
function requireInit() {
  const gh = readRef(REF_GH), rp = readRef(REF_RP);
  if (!gh || !rp) throw new Error('還沒初始化：先跑 node scripts/github-sync.js init');
  return { gh, rp };
}

function treeMap(ref) {
  return new Map(gitStr(['ls-tree', '-r', '-z', ref]).split('\0').filter(Boolean).map((l) => {
    const [meta, p] = l.split('\t'); const [mode, , sha] = meta.split(' '); return [p, { mode, sha }];
  }));
}

// Replit 自上次同步後改過的路徑（排除 pull 產生的 commit，那些內容本來就來自 GitHub）
function pendingReplitPaths(rp) {
  const paths = new Set();
  const commits = gitStr(['rev-list', '--reverse', `${rp}..HEAD`]).split('\n').filter(Boolean);
  for (const c of commits) {
    if (gitStr(['log', '-1', '--format=%B', c]).includes(PULL_TRAILER)) continue;
    for (const p of gitStr(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', c]).split('\0').filter(Boolean)) {
      if (!EXCLUDE.test(p)) paths.add(p);
    }
  }
  return [...paths].sort();
}

function status() {
  const { gh, rp } = requireInit();
  const main = fetchRemote();
  const ghAhead = gh === main ? 0 : Number(gitStr(['rev-list', '--count', `${gh}..${main}`]));
  const pending = pendingReplitPaths(rp);
  console.log(`GitHub ${GH} ${main.slice(0, 7)}：上次同步後 ${ghAhead} 個新 commit`);
  console.log(`Replit HEAD ${gitStr(['rev-parse', '--short', 'HEAD'])}：上次同步後改過 ${pending.length} 個檔案`);
  for (const p of pending.slice(0, 30)) console.log('  ' + p);
  return { ghAhead, pending };
}

function runUnit() {
  const r = spawnSync(process.execPath, ['scripts/run-tests.js', 'unit'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (!/unit：/.test(out)) return { ok: false, detail: 'unit runner 沒有跑完' };
  const failed = [...out.matchAll(/^\s+FAIL  (.+)$/gm)].map((m) => m[1].trim());
  let known = [];
  try { known = fs.readFileSync(path.join(ROOT, '.github/ci-known-unit-failures.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); } catch { /* 沒有清單就全部算新失敗 */ }
  const fresh = failed.filter((f) => !known.includes(f));
  return { ok: fresh.length === 0, detail: fresh.length ? '新增失敗：' + fresh.join(' ') : out.match(/── unit：[^\n]*/)[0] };
}

// 三方合併在「去個資後」的空間做：Replit 檔先換成假值，再與 GitHub 的舊版、新版合併，最後換回真值。
// 直接把 GitHub 的 patch 套到含真值的檔案，只要改動的行旁邊有個資就會被 git 判成衝突。
function mergeScrubbed(ours, base, theirs) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'github-sync-merge-'));
  try {
    const f = (n, s) => { const p = path.join(dir, n); fs.writeFileSync(p, s); return p; };
    const r = spawnSync('git', ['merge-file', '-p', f('ours', ours), f('base', base), f('theirs', theirs)], { encoding: 'utf8', maxBuffer: 1 << 28 });
    return r.status === 0 ? r.stdout : null;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function pull({ test = true } = {}) {
  const { gh } = requireInit();
  requireClean();
  const main = fetchRemote();
  if (main === gh) { console.log('GitHub 沒有新的改動。'); return false; }
  const data = loadData();
  const head = gitStr(['rev-parse', 'HEAD']);
  const rollback = (why) => { git(['reset', '-q', '--hard', head]); throw new Error(why + '（已還原到 ' + head.slice(0, 7) + '，沒有留下任何改動）'); };
  const changed = gitStr(['diff', '--name-status', '-z', '--no-renames', gh, main]).split('\0').filter(Boolean);
  const conflicts = [];
  for (let i = 0; i < changed.length; i += 2) {
    const st = changed[i], p = changed[i + 1];
    if (EXCLUDE.test(p)) continue;
    const file = path.join(ROOT, p);
    const exists = fs.existsSync(file);
    const blob = (ref) => git(['cat-file', 'blob', `${ref}:${p}`]);
    if (st === 'D') {
      // GitHub 刪除：Replit 版去個資後與 GitHub 舊版相同才刪
      if (!exists) continue;
      const ours = fs.readFileSync(file);
      const same = isText(ours) ? scrub(ours.toString('utf8'), data).text === blob(gh).toString('utf8') : ours.equals(blob(gh));
      if (same) git(['rm', '-q', '--', p]); else conflicts.push(p);
      continue;
    }
    const theirs = blob(main);
    const base = st === 'A' ? null : blob(gh);
    if (!isText(theirs)) {
      // 二進位：Replit 沒改過（等於 GitHub 舊版）或不存在才採用 GitHub 新版
      if (!exists || (base && fs.readFileSync(file).equals(base))) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, theirs); git(['add', '--', p]); }
      else conflicts.push(p);
      continue;
    }
    let merged;
    if (!exists) merged = theirs.toString('utf8');
    else {
      const ours = scrub(fs.readFileSync(file, 'utf8'), data).text;
      merged = mergeScrubbed(ours, base ? base.toString('utf8') : '', theirs.toString('utf8'));
    }
    if (merged === null) { conflicts.push(p); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, unscrub(merged, data));
    git(['add', '--', p]);
  }
  if (conflicts.length) rollback('套用 GitHub 的改動時有衝突：' + conflicts.join(' '));
  if (test) {
    const t = runUnit();
    if (!t.ok) rollback('套用後 unit 測試不過：' + t.detail);
    console.log('unit 測試：' + t.detail);
  }
  const range = `${gh.slice(0, 7)}..${main.slice(0, 7)}`;
  if (gitStr(['diff', '--cached', '--name-only'])) {
    git(['commit', '-q', '-F', '-'], { input: `同步 GitHub ${range}\n\n${PULL_TRAILER} ${main}\n` });
  }
  git(['update-ref', REF_GH, main]);
  console.log(`已同步 GitHub ${range} 到 Replit（${gitStr(['rev-parse', '--short', 'HEAD'])}）。`);
  return true;
}

function push({ dryRun = false } = {}) {
  const { gh, rp } = requireInit();
  requireClean();
  const main = fetchRemote();
  if (main !== gh) throw new Error('GitHub 有還沒同步進 Replit 的改動，先跑 pull（或直接用 sync）。');
  const pending = pendingReplitPaths(rp);
  if (!pending.length) { console.log('Replit 沒有要推到 GitHub 的改動。'); if (!dryRun) git(['update-ref', REF_RP, 'HEAD']); return null; }

  const data = loadData();
  const head = treeMap('HEAD');
  const lines = [];
  const unknown = [];
  const reals = Object.keys(data.map);
  for (const p of pending) {
    const entry = head.get(p);
    if (!entry) { lines.push({ remove: p }); continue; }
    let sha = entry.sha;
    const buf = git(['cat-file', 'blob', entry.sha]);
    if (isText(buf)) {
      const { text, unknown: u } = scrub(buf.toString('utf8'), data);
      for (const x of u) unknown.push({ path: p, ...x });
      const leaked = reals.filter((r) => text.includes(r));
      if (leaked.length) throw new Error(`去個資後 ${p} 仍含真值（${leaked.map(mask).join(', ')}），停止。`);
      sha = gitStr(['hash-object', '-w', '--stdin'], { input: Buffer.from(text, 'utf8') });
    }
    lines.push({ mode: entry.mode, sha, path: p });
  }
  if (unknown.length) {
    console.log('發現沒看過的個資格式，為了安全不推送。請逐一確認：');
    for (const u of unknown) console.log(`  ${u.path}:${u.line}  ${mask(u.value)}`);
    console.log('是測試用的假資料：node scripts/github-sync.js allow <檔案>:<行>');
    console.log('是真實資料：      node scripts/github-sync.js fake <檔案>:<行>');
    process.exitCode = 2;
    return null;
  }
  const idx = path.join(require('os').tmpdir(), `github-sync-${process.pid}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    git(['read-tree', main], { env });
    for (const l of lines) {
      if (l.remove) git(['update-index', '--force-remove', '--', l.remove], { env });
      else git(['update-index', '--add', '--cacheinfo', `${l.mode},${l.sha},${l.path}`], { env });
    }
    const tree = gitStr(['write-tree'], { env });
    if (tree === gitStr(['rev-parse', `${main}^{tree}`])) {
      console.log('去個資後內容與 GitHub 相同，不需要推送。');
      if (!dryRun) git(['update-ref', REF_RP, 'HEAD']);
      return null;
    }
    const msg = `同步 Replit ${gitStr(['rev-parse', '--short', 'HEAD'])}（${pending.length} 個檔案）\n\n`
      + pending.map((p) => '- ' + p).join('\n') + '\n\n電話、身分證字號、LINE UID、Email 的真值已換成固定的假值。\n';
    const commit = gitStr(['commit-tree', tree, '-p', main], { input: msg });
    console.log(`${dryRun ? '[dry-run] ' : ''}要推送的檔案 ${pending.length} 個：`);
    for (const p of pending.slice(0, 40)) console.log('  ' + p);
    if (dryRun) return commit;
    git(['push', '-q', REMOTE, `${commit}:refs/heads/${BRANCH}`]);
    git(['update-ref', REF_GH, commit]);
    git(['update-ref', REF_RP, 'HEAD']);
    console.log(`已推送到 GitHub ${BRANCH}：${commit.slice(0, 7)}`);
    return commit;
  } finally {
    try { fs.unlinkSync(idx); } catch { /* 沒建立就算了 */ }
  }
}

function init({ force = false } = {}) {
  if (readRef(REF_GH) && !force) throw new Error('已經初始化過；要重來請加 --force。');
  requireClean();
  const main = fetchRemote();
  const a = treeMap('HEAD'), b = treeMap(main);
  const map = {}, allow = new Set();
  let same = 0, scrubbed = 0;
  const ownDiff = [], replitOnly = [];
  for (const [p, x] of a) {
    if (EXCLUDE.test(p)) continue;
    const y = b.get(p);
    if (!y) { replitOnly.push(p); continue; }
    const rb = git(['cat-file', 'blob', x.sha]);
    if (!isText(rb)) { same += x.sha === y.sha; continue; }
    const rt = rb.toString('utf8');
    if (x.sha === y.sha) { same++; for (const c of candidates(rt)) allow.add(c.value); continue; }
    const pairs = alignPair(rt, git(['cat-file', 'blob', y.sha]).toString('utf8'));
    if (!pairs) { ownDiff.push(p); continue; }
    scrubbed++;
    for (const [real, fake] of pairs) {
      if (real === fake) { allow.add(real); continue; }
      if (map[real] && map[real] !== fake) throw new Error(`${p}：同一個真值在不同檔案對到不同假值（${mask(real)}），無法自動初始化。`);
      map[real] = fake;
    }
  }
  for (const real of Object.keys(map)) allow.delete(real);
  saveData({ map, allow });
  git(['update-ref', REF_GH, main]);
  git(['update-ref', REF_RP, 'HEAD']);
  console.log(`初始化完成：GitHub ${main.slice(0, 7)} ↔ Replit ${gitStr(['rev-parse', '--short', 'HEAD'])}`);
  console.log(`  完全相同 ${same} 檔；只差個資 ${scrubbed} 檔；真值↔假值 ${Object.keys(map).length} 組；允許的測試值 ${allow.size} 個`);
  console.log(`  兩邊內容不同、保留各自版本 ${ownDiff.length} 檔：${ownDiff.join(' ')}`);
  console.log(`  只在 Replit ${replitOnly.length} 檔：${replitOnly.slice(0, 10).join(' ')}`);
  return { map, allow, ownDiff, replitOnly };
}

function mark(kind, spec) {
  const m = /^(.+):(\d+)$/.exec(spec || '');
  if (!m) throw new Error('格式：<檔案>:<行>');
  const text = fs.readFileSync(path.join(ROOT, m[1]), 'utf8').split('\n')[Number(m[2]) - 1] || '';
  const data = loadData();
  const found = candidates(text).map((c) => c.value).filter((v) => !Object.hasOwn(data.map, v) && !data.allow.has(v));
  if (!found.length) throw new Error('那一行沒有待確認的值。');
  for (const v of found) {
    if (kind === 'allow') data.allow.add(v);
    else data.map[v] = fakeFor(v);
  }
  saveData(data);
  console.log(`${kind === 'allow' ? '標記為可公開' : '設定假值'}：${found.map(mask).join(', ')}`);
}

// 依格式產生假值：電話 0900 開頭、身分證保留首兩碼並修正檢查碼、LINE UID 隨機、Email 用 example.com
function fakeFor(v) {
  const h = crypto.randomBytes(16).toString('hex');
  const digits = (n) => (BigInt('0x' + h).toString().padStart(n, '0')).slice(-n);
  if (/^U[0-9a-f]{32}$/.test(v)) return 'U' + h;
  if (v.includes('@')) return `user${h.slice(0, 8)}@example.com`;
  if (/^[A-Z][12]\d{8}$/.test(v)) {
    const L = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
    const ok = (id) => { const n = 10 + L.indexOf(id[0]); const d = id.slice(1).split('').map(Number);
      return (Math.floor(n / 10) + (n % 10) * 9 + d.reduce((s, x, k) => s + x * [8, 7, 6, 5, 4, 3, 2, 1, 1][k], 0)) % 10 === 0; };
    const base = v.slice(0, 2) + digits(7);
    for (let c = 0; c < 10; c++) if (ok(base + c)) return base + c;
  }
  const fake = '0900' + digits(6);
  const od = v.replace(/\D/g, '');
  const fd = od.startsWith('8860') ? '8860' + fake.slice(1) : od.startsWith('886') ? '886' + fake.slice(1) : fake;
  let k = 0; return v.replace(/\d/g, () => fd[k++]);
}

module.exports = { scrub, unscrub, alignPair, candidates, fakeFor, pull, push, init, status, EXCLUDE };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const flags = new Set(process.argv.slice(2).filter((x) => x.startsWith('--')));
  try {
    if (cmd === 'status') status();
    else if (cmd === 'pull') pull({ test: !flags.has('--no-test') });
    else if (cmd === 'push') push({ dryRun: flags.has('--dry-run') });
    else if (cmd === 'sync') { pull({ test: !flags.has('--no-test') }); push({ dryRun: flags.has('--dry-run') }); }
    else if (cmd === 'init') init({ force: flags.has('--force') });
    else if (cmd === 'allow' || cmd === 'fake') mark(cmd, arg);
    else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 20).join('\n')); process.exitCode = cmd ? 1 : 0; }
  } catch (e) {
    console.error('停止：' + e.message);
    process.exitCode = 1;
  }
}
