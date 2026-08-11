'use strict';
/**
 * 後台權限三層一致性。
 *
 * 一個後台頁面的可見性寫在三個地方，任何一處漏改都會產生「打得開卻用不了」
 * 或反過來「看不到但其實有權限」：
 *
 *   1. Sidebar.jsx   NAV_GROUPS[].items[].roles  → 選單看不看得到
 *   2. App.jsx       <RequireAuth roles={...}>   → 路由進不進得去
 *   3. server/routes requireAdminRole(...)       → API 打不打得通
 *
 * 2026-08-11「退課處理開放櫃檯」的六層改動遺失後才被發現三層已經對不齊，
 * 而當時沒有任何東西會告訴你。這支測試補上那個告警。
 *
 * ── 為什麼掃全部而不是只驗 refund ──
 * 只驗一條的話，下一個頁面漏改時它照樣全綠。權限是最不該靠人記得去驗的東西。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const ROLES = ['admin', 'manager', 'staff'];
const norm = (list) => Array.from(new Set(list)).sort().join(',');

/** 把 roles={ALL} / roles={['a','b']} 這種寫法解析成陣列。ALL 是 App.jsx 的常數。 */
function parseRoles(expr, allValue) {
  const t = String(expr).trim();
  if (t === 'ALL') return allValue.slice();
  const out = [];
  const re = /'([a-z_]+)'/g;
  let m;
  while ((m = re.exec(t))) out.push(m[1]);
  return out;
}

// ── 來源一：Sidebar ────────────────────────────────────────────────────────
const sidebarSrc = read('client/admin/src/components/Sidebar.jsx');
const sidebar = new Map();
{
  const re = /\{\s*to:\s*'([^']+)'\s*,[^}]*?roles:\s*(\[[^\]]*\])/g;
  let m;
  while ((m = re.exec(sidebarSrc))) sidebar.set(m[1], parseRoles(m[2], ROLES));
}

// ── 來源二：App.jsx ────────────────────────────────────────────────────────
const appSrc = read('client/admin/src/App.jsx');
const allMatch = appSrc.match(/const\s+ALL\s*=\s*(\[[^\]]*\])/);
const ALL = allMatch ? parseRoles(allMatch[1], ROLES) : null;

const routeRoles = new Map();   // path → roles（有 RequireAuth 才收）
const routePaths = new Set();   // 所有 <Route path>，用來判斷「路由存不存在」
{
  const re = /<Route\s+path="([^"]+)"([\s\S]{0,240}?)\/>/g;
  let m;
  while ((m = re.exec(appSrc))) {
    const [, p, rest] = m;
    routePaths.add(p);
    const r = rest.match(/<RequireAuth\s+roles=\{([^}]*)\}/);
    if (r) routeRoles.set(p, parseRoles(r[1], ALL || ROLES));
  }
}

// ── 掃描失效偵測 ───────────────────────────────────────────────────────────
// 這幾條先跑：正則被改壞時要立刻停，而不是「零筆比對通過」的假綠燈。
check('掃描有效：Sidebar 解析到足夠的項目', () => {
  const declared = (sidebarSrc.match(/\{\s*to:\s*'\//g) || []).length;
  assert.ok(declared >= 20, '原始碼只找到 ' + declared + ' 個 to:，Sidebar 結構可能已改');
  assert.strictEqual(sidebar.size, declared,
    '宣告 ' + declared + ' 項但只解析出 ' + sidebar.size + ' 項 —— 正則沒跟上寫法變化，'
    + '漏掉的那幾項等於沒被檢查');
});

check('掃描有效：App.jsx 解析到路由與 ALL 常數', () => {
  assert.ok(ALL, '找不到 const ALL —— roles={ALL} 會被解析成空陣列，比對全部失真');
  assert.strictEqual(norm(ALL), norm(ROLES), 'ALL 的內容變了，測試的角色清單要同步');
  assert.ok(routePaths.size >= 25, '只解析到 ' + routePaths.size + ' 條路由，掃描失效');
  assert.ok(routeRoles.size >= 15, '只解析到 ' + routeRoles.size + ' 條有 RequireAuth 的路由');
});

// ── 一致性 ────────────────────────────────────────────────────────────────
check('Sidebar 的每個項目都有對應路由', () => {
  const missing = Array.from(sidebar.keys()).filter((p) => !routePaths.has(p));
  assert.deepStrictEqual(missing, [],
    '選單有這些項目但 App.jsx 沒有路由，點下去會 404：' + missing.join(', '));
});

check('Sidebar 與 App.jsx 的角色完全一致', () => {
  const bad = [];
  for (const [p, roles] of sidebar) {
    if (!routeRoles.has(p)) continue;   // 繼承外層 RequireAuth 的頁面（如 /dashboard）
    if (norm(roles) !== norm(routeRoles.get(p))) {
      bad.push(p + ' → 選單[' + norm(roles) + '] vs 路由[' + norm(routeRoles.get(p)) + ']');
    }
  }
  assert.deepStrictEqual(bad, [],
    '這些頁面選單與路由的權限對不齊 —— 使用者要嘛看得到卻進不去，'
    + '要嘛有權限卻找不到入口：\n       ' + bad.join('\n       '));
});

// ── 退課處理：連後端一起驗（Owner 2026-08-11 指定開放櫃檯）────────────────
check('退課處理三層都含 staff（含後端 API）', () => {
  const api = read('server/routes/admin/enrollments.js');
  const anchors = [
    ['GET /:id/refund-preview', /router\.get\('\/:id\/refund-preview',\s*requireAdminAuth,\s*requireAdminRole\(([^)]*)\)/],
    ['POST /:id/refund', /router\.post\('\/:id\/refund',\s*requireAdminAuth,\s*requireAdminRole\(([^)]*)\)/],
  ];
  for (const [label, re] of anchors) {
    const m = api.match(re);
    assert.ok(m, '掃描失效：找不到 ' + label + ' 的 requireAdminRole');
    assert.ok(parseRoles(m[1], ROLES).includes('staff'),
      label + ' 沒開放 staff —— 櫃檯打得開頁面但 API 會回 403');
  }
  assert.ok((sidebar.get('/refund') || []).includes('staff'), 'Sidebar 沒開放 staff');
  assert.ok((routeRoles.get('/refund') || []).includes('staff'), 'App.jsx 路由沒開放 staff');

  // 文案：只取 subtitle 屬性的「值」來驗，不掃整個檔案 —— 掃全文的話，
  // 說明為什麼要拿掉這四個字的註解本身就會讓測試失敗（這個坑踩過兩次）。
  const refundSrc = read('client/admin/src/pages/RefundPage.jsx');
  const sub = refundSrc.match(/<PageHeader\s+title="退課處理"\s+subtitle="([^"]*)"/);
  assert.ok(sub, '掃描失效：找不到 RefundPage 的 PageHeader subtitle');
  assert.ok(!/主管權限/.test(sub[1]),
    'RefundPage 副標仍寫「主管權限」，與實際權限不符：' + sub[1]);
});

if (failed) { console.error('admin_role_gate_consistency_test: ' + failed + ' failed'); process.exit(1); }
console.log('admin_role_gate_consistency_test: all passed');
