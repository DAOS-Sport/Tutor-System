'use strict';
// Ragic 時間軸 API 照 F-A06 設定判斷：要有 ragic-status 頁面，再加上
// ragic-status:timeline 動作權限（預設只有 admin，可在角色權限管理開放）。
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require(require.resolve('express', { paths: [path.join(__dirname, '../server')] }));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'ragic-timeline-gate-test-secret';
const granted = new Set(['manager:ragic-status', 'manager:ragic-status:timeline', 'staff:ragic-status']);
const rolePermissionsPath = require.resolve('../server/services/rolePermissions');
require.cache[rolePermissionsPath] = {
  id: rolePermissionsPath, filename: rolePermissionsPath, loaded: true,
  exports: {
    canUserAccess: async ({ role }, key) => role === 'admin' || granted.has(`${role}:${key}`),
    canUserDo: async ({ role }, key) => role === 'admin' || granted.has(`${role}:${key}`),
  },
};
require.cache[require.resolve('../server/models/db')] = {
  id: 'db', filename: 'db', loaded: true, exports: { pool: {} },
};

// 憑證即時失效檢查（adminSession）要查 DB；這裡只測權限閘門，視為有效憑證。
const adminSessionPath = require.resolve('../server/services/adminSession');
require.cache[adminSessionPath] = {
  id: adminSessionPath, filename: adminSessionPath, loaded: true,
  exports: { checkToken: async () => null, invalidate: () => {}, snapshot: async () => null },
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
    assert.equal(manager.status, 200, 'F-A06 開了頁面與時間軸動作的 manager 應讀得到');

    const staff = await get(server, 'staff');
    assert.equal(staff.status, 403, '只有頁面、沒有時間軸動作權限的角色必須擋下');

    const lifeguard = await get(server, 'lifeguard');
    assert.equal(lifeguard.status, 403, '兩者都沒有的角色必須擋下');

    console.log('PASS Ragic 時間軸照 F-A06 判斷：頁面＋時間軸動作都開放才讀得到');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
