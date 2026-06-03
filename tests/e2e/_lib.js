// 共用 helper：fetch 包裝 + 簡易斷言 + 顏色 log
const fs = require('fs');
const os = require('os');
const path = require('path');
const BASE = process.env.BASE_URL || 'http://localhost:3000';

// 後台登入限流為 5 次 / 5 分鐘 / IP（server/routes/admin/auth.js）。run_all 以 spawnSync 開
// 獨立子行程、記憶體不共享，各路徑各自 loginAdmin 會累計超過 5 次而被 429。
// 解法（純測試層）：以「檔案」快取各帳號 token，跨子行程共用；同帳號整輪只實際登入一次。
const TOKEN_CACHE = process.env.E2E_TOKEN_CACHE || path.join(os.tmpdir(), 'daos-e2e-tokens.json');
const TOKEN_TTL_MS = 4 * 60 * 1000; // 短於限流視窗，避免用到過期 token
function readTokenCache() {
  try { return JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8')); } catch { return {}; }
}
function writeTokenCache(c) {
  try { fs.writeFileSync(TOKEN_CACHE, JSON.stringify(c)); } catch { /* noop */ }
}
function clearTokenCache() {
  try { fs.unlinkSync(TOKEN_CACHE); } catch { /* noop */ }
}

async function call(method, path, { token, body, query } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = await res.text(); }
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓', msg);
}

function step(name) { console.log('\n▶', name); }

async function loginAdmin(username, password) {
  const cache = readTokenCache();
  const hit = cache[username];
  if (hit && hit.token && (Date.now() - hit.ts) < TOKEN_TTL_MS) return hit.token;
  const r = await call('POST', '/api/admin/auth/login', {
    body: { username, password },
  });
  if (r.status !== 200 || !r.data?.token) throw new Error('admin login failed: ' + JSON.stringify(r.data));
  cache[username] = { token: r.data.token, ts: Date.now() };
  writeTokenCache(cache);
  return r.data.token;
}

module.exports = { BASE, call, assert, step, loginAdmin, clearTokenCache };
