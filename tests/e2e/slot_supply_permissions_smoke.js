'use strict';
/**
 * 模組 1 權限 smoke test（HTTP 層，非 mock）
 *
 * 驗證「誰能碰什麼」。純函式測試證明不了這件事——中介層順序寫錯、
 * 路由掛錯前綴、角色清單漏一個，都只有真的發 request 才會發現。
 *
 * 需要一個已啟動的 server：
 *   BASE_URL=http://localhost:3999 node tests/e2e/slot_supply_permissions_smoke.js
 *
 * 不需要任何有效帳號即可驗證「未登入一律被擋」；
 * 若提供 ADMIN_TOKEN / MANAGER_TOKEN / STAFF_TOKEN / COACH_TOKEN / PARENT_TOKEN
 * 則一併驗證跨角色的拒絕與放行。
 */
const assert = require('assert');
const BASE = process.env.BASE_URL || 'http://localhost:3999';

const TOKENS = {
  admin: process.env.ADMIN_TOKEN, manager: process.env.MANAGER_TOKEN,
  staff: process.env.STAFF_TOKEN, coach: process.env.COACH_TOKEN, parent: process.env.PARENT_TOKEN,
};

async function call(method, path, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers });
  return res.status;
}

const DENY = new Set([401, 403]);

async function main() {
  const results = [];
  const check = async (label, method, path, token, expect) => {
    const status = await call(method, path, token);
    const ok = typeof expect === 'function' ? expect(status) : status === expect;
    results.push({ label, status, ok });
    if (!ok) console.error(`  ✗ ${label} → ${status}`);
    else console.log(`  ✓ ${label} → ${status}`);
  };

  console.log('未登入一律被擋：');
  await check('GET  /api/admin/venue-hours（未登入）', 'GET', '/api/admin/venue-hours', null, (s) => DENY.has(s));
  await check('PUT  /api/admin/venue-hours/B（未登入）', 'PUT', '/api/admin/venue-hours/B', null, (s) => DENY.has(s));
  await check('GET  /api/admin/venue-hours/closed-dates（未登入）', 'GET', '/api/admin/venue-hours/closed-dates', null, (s) => DENY.has(s));
  await check('GET  /api/slots/period/x（未登入）', 'GET', '/api/slots/period/00000000-0000-0000-0000-000000000000', null, (s) => DENY.has(s));
  await check('DELETE /api/slots/booking/x（未登入）', 'DELETE', '/api/slots/booking/00000000-0000-0000-0000-000000000000', null, (s) => DENY.has(s));
  await check('POST /api/slots/period/x/ack-notice（未登入）', 'POST', '/api/slots/period/00000000-0000-0000-0000-000000000000/ack-notice', null, (s) => DENY.has(s));
  await check('GET  /api/admin/ragic-status/sync-failures（未登入）', 'GET', '/api/admin/ragic-status/sync-failures', null, (s) => DENY.has(s));

  if (TOKENS.staff) {
    console.log('櫃檯（staff）不得碰營業時間：');
    await check('GET  venue-hours（staff）', 'GET', '/api/admin/venue-hours', TOKENS.staff, 403);
    await check('PUT  venue-hours（staff）', 'PUT', '/api/admin/venue-hours/B', TOKENS.staff, 403);
  }
  if (TOKENS.coach) {
    console.log('教練不得碰後台：');
    await check('GET  venue-hours（coach token）', 'GET', '/api/admin/venue-hours', TOKENS.coach, (s) => DENY.has(s));
  }
  if (TOKENS.parent) {
    console.log('家長不得碰後台，但可用自己的預約端點：');
    await check('GET  venue-hours（parent token）', 'GET', '/api/admin/venue-hours', TOKENS.parent, (s) => DENY.has(s));
    await check('DELETE 別人的預約（parent）', 'DELETE', '/api/slots/booking/00000000-0000-0000-0000-000000000000', TOKENS.parent, 404);
  }
  if (TOKENS.manager) {
    console.log('場館主管可讀寫營業時間：');
    await check('GET  venue-hours（manager）', 'GET', '/api/admin/venue-hours', TOKENS.manager, 200);
  }
  if (TOKENS.admin) {
    console.log('管理員全通：');
    await check('GET  venue-hours（admin）', 'GET', '/api/admin/venue-hours', TOKENS.admin, 200);
    await check('GET  sync-failures（admin）', 'GET', '/api/admin/ragic-status/sync-failures', TOKENS.admin, 200);
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = Object.entries(TOKENS).filter(([, v]) => !v).map(([k]) => k);
  if (skipped.length) console.log(`（未提供 token，略過跨角色驗證：${skipped.join(', ')}）`);
  assert.strictEqual(failed.length, 0, `${failed.length} 項權限檢查未通過`);
  console.log(`slot_supply_permissions_smoke: PASS（${results.length} 項）`);
}

main().catch((e) => { console.error('slot_supply_permissions_smoke: FAIL —', e.message); process.exit(1); });