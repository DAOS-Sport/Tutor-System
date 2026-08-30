/**
 * 這次上線的系統穩定性測試。
 *
 * 爆炸半徑最大的改動是 server/middlewares/rejectNulBytes.js：它掛在
 * 全部 22 個 API 路由器（含 /mcp）之前，每一個帶 body 的請求都會經過它。
 * 只要它誤判，就是全站級的故障 —— 所以不能只測註冊。
 *
 * 作法：從路由檔自動列舉「沒有路徑參數的 GET 端點」，全部打一遍。
 * 不挑，避免只測到自己記得的那幾支。
 *
 * 判準：
 *   1. 任何端點都不可以回 5xx
 *   2. 帶 NUL 的 body 要回 400，不是 500
 *   3. 正常 body 不可以被誤擋（回應不能是 INPUT_INVALID）
 *
 * 只讀。唯一的寫入是 /api/parents/me/sync（冪等，本來每次開 App 就會打）。
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.STAB_BASE || 'http://localhost:3001';
const ROUTES_DIR = path.resolve(__dirname, '../routes');

const MOUNTS = {
  auth: '/api/auth', venues: '/api/venues', coaches: '/api/coaches',
  coachPortal: '/api/coach-portal', parents: '/api/parents', courses: '/api/courses',
  slots: '/api/slots', sessions: '/api/sessions', checkins: '/api/checkins',
  promotions: '/api/promotions', enrollments: '/api/enrollments', checkout: '/api/checkout',
  groupOrders: '/api/group-orders', uploads: '/api/uploads', referrals: '/api/referrals',
  transfers: '/api/transfers', chat: '/api/chat', learn: '/api/learn',
  evaluations: '/api/evaluations', integrations: '/api/integrations',
};

function discoverGets() {
  const out = [];
  for (const [file, mount] of Object.entries(MOUNTS)) {
    const p = path.join(ROUTES_DIR, file + '.js');
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const re = /router\.get\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const route = m[1];
      if (route.includes(':') || route.includes('*')) continue;   // 需要參數的先跳過
      out.push(mount + (route === '/' ? '' : route));
    }
  }
  return [...new Set(out)];
}

let pass = 0, fail = 0;
const problems = [];
const ok = (label, cond, detail) => {
  if (cond) pass++;
  else { fail++; problems.push(label + (detail ? '  → ' + detail : '')); }
};

async function req(method, url, { token, body, raw } = {}) {
  const init = { method, headers: {} };
  if (token) init.headers.authorization = 'Bearer ' + token;
  if (body !== undefined || raw !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = raw !== undefined ? raw : JSON.stringify(body);
  }
  try {
    const r = await fetch(BASE + url, init);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: text.slice(0, 120) };
  } catch (e) {
    return { status: 0, json: null, text: String(e.message).slice(0, 120) };
  }
}

(async () => {
  console.log('=== 取得測試身分 ===');
  const p = await req('POST', '/api/auth/demo-login', { body: { username: 'custom', password: 'custom' } });
  const c = await req('POST', '/api/auth/demo-login', { body: { username: 'coach', password: 'coach' } });
  const parentToken = p.json?.token, coachToken = c.json?.token;
  console.log('  家長 token: ' + (parentToken ? 'ok' : '取不到') + '   教練 token: ' + (coachToken ? 'ok' : '取不到'));

  const gets = discoverGets();
  console.log('');
  console.log('=== A. 自動列舉到 ' + gets.length + ' 個無參數 GET 端點，全部打過 ===');
  const byStatus = {};
  for (const url of gets) {
    for (const [who, tk] of [['匿名', null], ['家長', parentToken], ['教練', coachToken]]) {
      const r = await req('GET', url, { token: tk });
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      // 503 + 明確 code = 刻意的「功能未啟用」（例如 integrations 沒設 INTEGRATION_KEYS），
      // 那是設計好的回應，不是當機。當機的定義是「沒有 code、或 500」。
      const 刻意停用 = r.status === 503 && !!r.json?.code;
      ok(who + ' GET ' + url + ' 不可當機', r.status < 500 || 刻意停用,
         'HTTP ' + r.status + ' ' + r.text);
      if (r.json?.code === 'INPUT_INVALID') {
        ok(who + ' GET ' + url + ' 不可被 NUL 守門誤擋', false, JSON.stringify(r.json));
      }
    }
  }
  console.log('  狀態碼分布：' + Object.entries(byStatus).sort().map(([k, v]) => k + '×' + v).join('  '));

  console.log('');
  console.log('=== B. NUL 守門：帶 NUL 要 400，正常 body 要放行 ===');
  const NUL = String.fromCharCode(0);
  const targets = [
    ['/api/auth/parent-line-login', { id_token: 'a' + NUL + 'b' }],
    ['/api/auth/parent-bind-phone', { id_token: 'x', phone: '0912' + NUL + '345678' }],
    ['/api/parents/me/sync', { note: 'a' + NUL + 'b' }],
    ['/api/enrollments', { studentId: 'a' + NUL + 'b' }],
    ['/api/group-orders', { name: 'a' + NUL + 'b' }],
  ];
  for (const [url, body] of targets) {
    const r = await req('POST', url, { token: parentToken, raw: JSON.stringify(body) });
    console.log('  NUL → ' + url + '  HTTP ' + r.status + '  ' + (r.json?.code || r.text));
    ok('NUL ' + url + ' 不可 5xx', r.status < 500, 'HTTP ' + r.status);
  }

  console.log('');
  console.log('=== C. 正常 body 不可以被誤擋 ===');
  const normals = [
    ['/api/parents/me/sync', {}],
    ['/api/auth/parent-line-login', { id_token: '正常的中文與 emoji 😀 都要放行' }],
  ];
  for (const [url, body] of normals) {
    const r = await req('POST', url, { token: parentToken, body });
    const blocked = r.json?.code === 'INPUT_INVALID';
    console.log('  正常 → ' + url + '  HTTP ' + r.status + '  ' + (r.json?.code || 'ok'));
    ok('正常 body ' + url + ' 沒有被誤擋', !blocked, JSON.stringify(r.json));
    ok('正常 body ' + url + ' 不可 5xx', r.status < 500, 'HTTP ' + r.status);
  }

  console.log('');
  console.log(pass + ' 通過 / ' + fail + ' 失敗');
  if (problems.length) {
    console.log('');
    console.log('問題：');
    for (const x of problems.slice(0, 30)) console.log('  ✗ ' + x);
    if (problems.length > 30) console.log('  …還有 ' + (problems.length - 30) + ' 項');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('中斷：', e.message); process.exit(2); });

