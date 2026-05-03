// 共用 helper：fetch 包裝 + 簡易斷言 + 顏色 log
const BASE = process.env.BASE_URL || 'http://localhost:3000';

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
  const r = await call('POST', '/api/admin/auth/login', {
    body: { username, password },
  });
  if (r.status !== 200 || !r.data?.token) throw new Error('admin login failed: ' + JSON.stringify(r.data));
  return r.data.token;
}

module.exports = { BASE, call, assert, step, loginAdmin };
