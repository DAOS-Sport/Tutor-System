'use strict';
// 開課函式住在 service（#36）：兩個對帳入口共用 services/periodProvisioning，不再透過路由借用。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const NAMES = ['getSettings', 'ensureGroupCoursePeriod', 'ensureSoloCoursePeriod', 'commonPurchasedMultiplier'];

check('service 匯出四個函式', () => {
  const svc = require('../server/services/periodProvisioning');
  for (const n of NAMES) assert.equal(typeof svc[n], 'function', n);
});

check('路由檔不再定義、也不再對外借出開課函式', () => {
  const src = read('server/routes/admin/enrollments.js');
  for (const n of NAMES) assert.ok(!new RegExp(`^(async )?function ${n}[(]`, 'm').test(src), `${n} 又寫回路由檔`);
  assert.ok(!/_checkoutInternals/.test(src), '路由又掛回 _checkoutInternals');
});

check('兩個對帳入口都從 service 取用', () => {
  for (const f of ['server/routes/admin/enrollments.js', 'server/routes/admin/checkouts.js']) {
    assert.ok(/require\('\.\.\/\.\.\/services\/periodProvisioning'\)/.test(read(f)), `${f} 沒有用 periodProvisioning`);
  }
  assert.ok(!/require\('\.\/enrollments'\)/.test(read('server/routes/admin/checkouts.js')), 'checkouts.js 又去 require 兄弟路由');
});

if (failures) { console.error(`period_provisioning_test: ${failures} FAIL`); process.exit(1); }
console.log('PASS 開課函式在 services/periodProvisioning，兩個對帳入口共用');
