const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('../server/node_modules/express');
const token = 'test-only-token';
const configPath = require('node:path').resolve(__dirname, '../server/config/reconciliation-reader.json');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { tokenSha256: crypto.createHash('sha256').update(token).digest('hex') } };
let queries = 0, failDb = false;
const pool = { async query(sql) {
  queries++;
  if (failDb) throw new Error('test database unavailable');
  if (sql.includes('SELECT checkout_id')) return { rows: [{ checkout_id: 'payment-1' }] };
  return { rows: [{ checkout_id: 'payment-1', total_amount: 1200, payment_status: 'pending_reconcile',
    transfer_last_5: '00123', payment_proof_url: '/private-proof.png', created_at: '2026-09-08T05:00:00.000Z',
    parent_phone: 'PRIVATE-PHONE', sub_orders: [{ students: ['測試學員'], venue_id: 'V', venue_name: '測試場館' }, { students: ['測試學員'], venue_id: 'V', venue_name: '測試場館' }] }] };
} };
const dbPath = require.resolve('../server/models/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };
let router;
try { router = require('../server/routes/reconciliation'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
assert.equal(typeof router, 'function', 'A scoped read-only reconciliation feed must exist');
const app = express(); app.use('/api/integrations/reconciliation', router);
const server = app.listen(0, '127.0.0.1');
(async () => {
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/integrations/reconciliation`;
  try {
    for (const headers of [{}, { authorization: 'Bearer wrong' }]) assert.equal((await fetch(url, { headers })).status, 401);
    assert.equal(queries, 0, 'Unauthorized callers cannot read the database');
    const headers = { authorization: `Bearer ${token}` };
    let response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const data = await response.json();
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].orderCount, 2);
    assert.equal(data.records[0].studentNames, '測試學員');
    assert.equal(data.records[0].expectedAmount, 1200);
    assert.equal(data.records[0].accountLastFive, '00123');
    assert.equal(data.records[0].hasPaymentProof, true);
    assert.ok(!JSON.stringify(data).includes('PRIVATE-PHONE'));
    assert.ok(!JSON.stringify(data).includes('/private-proof.png'));
    const before = queries;
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 404);
    assert.equal(queries, before, 'Feed must not accept writes');
    failDb = true;
    response = await fetch(url, { headers });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('records'), 'Unavailable must not masquerade as an empty list');
    console.log('tutoring feed: authorization, grouping, privacy, read-only and outage checks passed');
  } finally { server.closeAllConnections(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
