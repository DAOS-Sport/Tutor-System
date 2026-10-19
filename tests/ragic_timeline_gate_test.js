'use strict';
// Ragic 時間軸 API 跟 Ragic 狀態頁共用 F-A06 的 ragic-status 權限：
// 管理員把該頁開給誰，誰就讀得到時間軸資料；沒開的人一律 403。
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require(require.resolve('express', { paths: [path.join(__dirname, '../server')] }));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'ragic-timeline-gate-test-secret';
const granted = new Set(['manager:ragic-status']);
const rolePermissionsPath = require.resolve('../server/services/rolePermissions');
require.cache[rolePermissionsPath] = {
  id: rolePermissionsPath, filename: rolePermissionsPath, loaded: true,
  exports: { canUserAccess: async ({ role }, key) => role === 'admin' || granted.has(`${role}:${key}`) },
};
require.cache[require.resolve('../server/models/db')] = {
  id: 'db', filename: 'db', loaded: true, exports: { pool: {} },
};

const { signToken } = require('../server/middlewares/adminAuth');
const { createRouter } = require('../server/routes/admin/ragicTimeline');

const app = express();
app.use('/t', createRouter({ list: async () => ({ items: ['row'] }), get: async (id) => ({ id }) }));

function get(server, role) {
  const token = signToken({ sub: 1, role, venue_ids: [] });
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path: '/t', headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  try {
    const admin = await get(server, 'admin');
    assert.equal(admin.status, 200);
    assert.deepEqual(JSON.parse(admin.body), { items: ['row'] });

    const manager = await get(server, 'manager');
    assert.equal(manager.status, 200, 'F-A06 開了 ragic-status 的 manager 應讀得到時間軸');

    const staff = await get(server, 'staff');
    assert.equal(staff.status, 403, '沒開 ragic-status 的角色必須擋下');

    console.log('PASS Ragic 時間軸照 F-A06 ragic-status 判斷：有開放讀得到、沒開放 403');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
