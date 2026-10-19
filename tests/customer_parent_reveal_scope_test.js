'use strict';
// 手動建檔頁可以讀家長與學員（F-A06 manual-enroll），但只看遮罩值；
// ?reveal=1 顯示身分證原值仍要有 Z01 家長頁（customer-parents）權限。
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require(require.resolve('express', { paths: [path.join(__dirname, '../server')] }));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'customer-parent-reveal-test-secret';
const grants = {
  manager: new Set(['manual-enroll', 'customer-parents']),
  staff: new Set(['manual-enroll']),
  lifeguard: new Set(),
};
const rolePermissionsPath = require.resolve('../server/services/rolePermissions');
require.cache[rolePermissionsPath] = {
  id: rolePermissionsPath, filename: rolePermissionsPath, loaded: true,
  exports: { canUserAccess: async ({ role }, key) => role === 'admin' || grants[role]?.has(key) },
};

const { pool } = require('../server/models/db');
pool.query = async (sql) => {
  if (sql.includes('FROM parents p WHERE p.id')) {
    return { rowCount: 1, rows: [{ id: 'p1', name: '合成家長', phone: '0900000000', primary_venue_id: 'v1' }] };
  }
  if (sql.includes('FROM students WHERE parent_id')) {
    return { rowCount: 1, rows: [{ id: 's1', parent_id: 'p1', name: '合成學員', id_number: 'A123456789' }] };
  }
  throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
};

// 憑證即時失效檢查（adminSession）要查 DB；這裡只測權限閘門，視為有效憑證。
const adminSessionPath = require.resolve('../server/services/adminSession');
require.cache[adminSessionPath] = {
  id: adminSessionPath, filename: adminSessionPath, loaded: true,
  exports: { checkToken: async () => null, invalidate: () => {}, snapshot: async () => null },
};
const { signToken } = require('../server/middlewares/adminAuth');
const app = express();
app.use('/cp', require('../server/routes/admin/customerParents'));

function get(server, role, url) {
  const token = signToken({ sub: 1, role, venue_ids: ['v1'] });
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path: url, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  const log = console.log;
  console.log = () => {};
  try {
    const staff = await get(server, 'staff', '/cp/p1?reveal=1');
    const manager = await get(server, 'manager', '/cp/p1?reveal=1');
    const lifeguard = await get(server, 'lifeguard', '/cp/p1');
    console.log = log;

    assert.equal(staff.status, 200, '只有 manual-enroll 的角色要讀得到家長（手動建檔頁）');
    assert.notEqual(staff.json.students[0].id_number, 'A123456789', '只有 manual-enroll 不得看到身分證原值');
    assert.equal(manager.status, 200);
    assert.equal(manager.json.students[0].id_number, 'A123456789', '有 Z01 權限的 reveal 照舊顯示原值');
    assert.equal(lifeguard.status, 403, '兩個頁面都沒開的角色要擋下');
    log('PASS 手動建檔可讀家長但只看遮罩值；顯示原值仍需 Z01 權限');
  } finally {
    console.log = log;
    server.close();
    await pool.end().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
