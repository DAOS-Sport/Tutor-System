'use strict';
// 「admin_staff.role 代表值算不算真身分」只能有一份判準：登入、權限聯集、員工徽章共用。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isRepresentativeRoleReal: real } = require('../server/constants/roles');

assert.equal(real({ role: 'admin', is_coach: true }), true, 'admin 一律是真身分');
assert.equal(real({ role: 'manager', is_lifeguard: true }), true, 'manager 一律是真身分');
assert.equal(real({ role: 'staff', is_counter: true, is_coach: true }), true, '有櫃台旗標就是櫃台');
assert.equal(real({ role: 'staff' }), true, '沒有任何具體身分的一般員工維持代表值');
assert.equal(real({ role: 'staff', is_coach: true }), false, '純教練的 staff 只是 CHECK 保底值');
assert.equal(real({ role: 'staff', is_lifeguard: true }), false, '純救生員的 staff 只是 CHECK 保底值');

const ROOT = path.resolve(__dirname, '..');
const users = ['server/routes/admin/auth.js', 'server/services/rolePermissions.js', 'server/routes/admin/staff.js'];
for (const rel of users) {
  assert.match(fs.readFileSync(path.join(ROOT, rel), 'utf8'), /isRepresentativeRoleReal\(/, `${rel} 要用共用判準`);
}

const copies = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'public') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (p.endsWith('.js') && /!\s*\w*\.?is_?[cC]oach\w*\s*&&\s*!\s*\w*\.?is_?[lL]ifeguard/.test(fs.readFileSync(p, 'utf8'))) {
      copies.push(path.relative(ROOT, p));
    }
  }
})(path.join(ROOT, 'server'));
assert.deepEqual(copies, ['server/constants/roles.js'], '判準被另外抄了一份，請改呼叫 isRepresentativeRoleReal');

console.log('PASS 代表值身分判準只有一份，登入／權限／徽章共用');
