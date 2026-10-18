// Exercise the real checkout service on a disposable database. No HTTP, payment
// provider, Ragic or LINE calls. This is not full payment-flow load certification.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Pool } = require('../server/node_modules/pg');
const { createCheckoutSession } = require('../server/services/checkouts');

(async () => {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /audit|test/);
  const pool = new Pool({ connectionString: url.toString(), max: 8 });
  const prefix = randomUUID(), batches = [], durations = [];
  let parentIds = [];
  async function create(parentId, batchId, requestId) {
    const client = await pool.connect(), start = performance.now();
    try {
      await client.query('BEGIN');
      const result = await createCheckoutSession(client, {
        parentId, enrollmentBatchId: batchId, requestId,
        totalAmount: 1200, by: 'isolated-capacity-test', paymentMethod: 'bank_transfer',
      });
      await client.query('COMMIT');
      durations.push(performance.now() - start);
      return result;
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }
  try {
    for (let i = 0; i < 2; i++) {
      const id = randomUUID(); parentIds.push(id);
      await pool.query('INSERT INTO parents(id,name,phone) VALUES($1,$2,$3)', [id, 'isolated capacity', `test-${prefix.slice(0, 10)}-${i}`]);
    }
    // 2026-09-18 observed historical maximum: four checkout events per second.
    for (let burst = 0; burst < 3; burst++) {
      await Promise.all(Array.from({ length: 4 }, (_, i) => {
        const batch = randomUUID(); batches.push(batch);
        return create(parentIds[i % 2], batch, randomUUID());
      }));
    }
    const sameBatch = randomUUID(), sameRequest = randomUUID(); batches.push(sameBatch);
    const same = await Promise.all(Array.from({ length: 4 }, () => create(parentIds[0], sameBatch, sameRequest)));
    assert.equal(new Set(same.map(r => r.checkout_id)).size, 1, 'concurrent replay creates one checkout');
    await create(parentIds[1], sameBatch, sameRequest);
    const rows = (await pool.query('SELECT * FROM checkout_sessions WHERE parent_id=ANY($1::uuid[])', [parentIds])).rows;
    assert.equal(rows.length, 14);
    assert.equal(rows.filter(r => r.enrollment_batch_id === sameBatch).length, 2, 'different families stay separate');
    for (const row of rows) { assert.equal(Number(row.total_amount), 1200); assert.equal(row.payment_status, 'pending_payment'); }
    durations.sort((a, b) => a - b);
    console.log(JSON.stringify({ result: 'PASS', scope: 'real checkout service + PostgreSQL only; not payment HTTP E2E', historicalBurst: 4,
      requests: durations.length, distinctCheckouts: rows.length, p95_ms: Math.round(durations[Math.ceil(durations.length * 0.95) - 1]), max_ms: Math.round(durations.at(-1)) }));
  } finally {
    await pool.query('DELETE FROM checkout_sessions WHERE parent_id=ANY($1::uuid[])', [parentIds]);
    await pool.query('DELETE FROM parents WHERE id=ANY($1::uuid[])', [parentIds]);
    await pool.end();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
