#!/usr/bin/env node
'use strict';
// 檢查 F-A06 的閱讀原則：某角色被開放某頁，該頁用到的每支 GET API 都要讀得到。
// 頁面本身打得開、資料卻有一半 403，是這裡要抓的狀況。
//
//   node scripts/audit-page-permissions.js          列出缺口，有缺口 exit 1
//   node scripts/audit-page-permissions.js --json   輸出完整對照表
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-page-permissions-only';

const { loadAdminRouteGates } = require('./lib/adminRouteGates');
const { loadAdminPageApis } = require('./lib/adminPageApis');
const { ADMIN_RESOURCES } = require(path.join(__dirname, '..', 'server', 'constants', 'adminResources'));

// 刻意的例外：頁面上那塊資料只對部分角色顯示，前端已用 can() / isAdmin 擋住不去讀。
// 新增項目要寫清楚前端在哪裡擋；前端拿掉判斷卻沒拿掉這裡，就會變成真缺口。
const EXPECTED_GAPS = [
  { page: '/dashboard', api: 'GET /enrollments/stats',
    why: 'DashboardPage 以 canEnrollStats（同一組 key）判斷，沒權限就不呼叫，統計卡顯示空值' },
  { page: '/ragic-z03', api: 'GET /ragic-z03/review-archive/preview',
    why: '歸檔預覽是 admin 專屬操作，RagicZ03Page 只對 isAdmin 顯示按鈕；後端名單見 role_gate_coverage_test' },
];

// `${qs}` 接在非斜線後面是查詢字串，不是路徑參數
const normalize = (p) => p.replace(/([^/]):p/g, '$1').replace(/\/+$/, '') || '/';

function matches(frontPath, backPath) {
  const f = normalize(frontPath).split('/');
  const b = backPath.split('/');
  if (f.length !== b.length) return false;
  return f.every((seg, i) => (b[i].startsWith(':') ? true : seg !== ':p' && seg === b[i]));
}

function findRoute(routes, call) {
  return routes.find((r) => (r.method === call.method || r.method === '_ALL') && matches(call.path, r.path));
}

// 有頁面權限 key 的人，過不過得了這支 API 的閘門
function blockedGates(route, key) {
  return route.gates.filter((g) => {
    if (g.type === 'login' || g.type === 'anyBackoffice') return false;
    if (g.type === 'resource') return !g.keys.includes(key);
    return true;
  });
}

function describe(g) {
  if (g.type === 'resource') return `需要 ${g.keys.join(' 或 ')}`;
  if (g.type === 'role') return `寫死角色 ${g.roles.join('/')}`;
  return g.type;
}

function audit() {
  const routes = loadAdminRouteGates();
  const { pages, layoutCalls } = loadAdminPageApis();
  const keyByPath = Object.fromEntries(ADMIN_RESOURCES.map((r) => [r.path, r.key]));
  const findings = [];
  const unmatched = [];

  const check = (page, key, calls) => {
    const seen = new Set();
    for (const call of calls) {
      if (call.method !== 'GET') continue;
      const id = `${call.method} ${normalize(call.path)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const route = findRoute(routes, call);
      if (!route) { unmatched.push({ page, call: id, via: call.via }); continue; }
      const blocked = key === null ? [] : blockedGates(route, key);
      if (blocked.length) {
        findings.push({ page, key, api: `${route.method} ${route.path}`, via: call.via, file: call.file, blocked: blocked.map(describe) });
      }
    }
  };

  for (const [routePath, info] of Object.entries(pages)) {
    const key = keyByPath[routePath];
    if (key === undefined) continue; // 不屬於 F-A06 的頁面（登入、SOP、只限 admin 的待審核區）
    check(routePath, key, info.calls);
  }
  // 每頁都會載入的外框：只要能登入後台就要讀得到
  check('(外框 AppLayout)', 'anyBackoffice', layoutCalls);

  const isExpected = (f) => EXPECTED_GAPS.some((e) => e.page === f.page && e.api === f.api);
  const stale = EXPECTED_GAPS.filter((e) => !findings.some((f) => f.page === e.page && f.api === e.api));
  return { findings: findings.filter((f) => !isExpected(f)), expected: findings.filter(isExpected), stale, unmatched, pages, routes };
}

module.exports = { audit, normalize, matches, EXPECTED_GAPS };

if (require.main === module) {
  const { findings, expected, stale, unmatched, pages } = audit();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ findings, unmatched, pages }, null, 2));
  } else {
    for (const f of findings) {
      console.log(`缺口  ${f.page}（${f.key}）→ ${f.api}  ${f.blocked.join('；')}  [${f.file} ${f.via}]`);
    }
    for (const f of expected) console.log(`例外  ${f.page} → ${f.api}`);
    for (const e of stale) console.log(`例外名單過期（缺口已不存在，請移除）  ${e.page} → ${e.api}`);
    for (const u of unmatched) console.log(`對不到後端  ${u.page} → ${u.call}  [${u.via}]`);
    console.log(`\n${Object.keys(pages).length} 個頁面，${findings.length} 個閱讀缺口，${unmatched.length} 個對不到後端的呼叫`);
  }
  process.exit(findings.length || stale.length ? 1 : 0);
}
