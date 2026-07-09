// Checkout idempotency：同一 enrollment_batch_id 無論重送或並發建立，都只收斂到一筆 checkout_sessions。
const { randomUUID } = require('crypto');
const { Pool } = require('../../server/node_modules/pg');
const { assert, step } = require('./_lib');

async function upsertCheckout(pg, batchId, parentId = null) {
  const conflict = parentId
    ? `ON CONFLICT (parent_id, enrollment_batch_id)
       WHERE parent_id IS NOT NULL AND enrollment_batch_id IS NOT NULL`
    : `ON CONFLICT (enrollment_batch_id)
       WHERE parent_id IS NULL AND enrollment_batch_id IS NOT NULL`;
  const r = await pg.query(
    `INSERT INTO checkout_sessions
       (parent_id, enrollment_batch_id, total_amount, payment_status, current_route_state)
     VALUES ($1, $2, 1000, 'pending_payment', 'pending_payment')
     ${conflict}
     DO UPDATE SET updated_at = checkout_sessions.updated_at
     RETURNING checkout_id`,
    [parentId, batchId],
  );
  return r.rows[0].checkout_id;
}

(async () => {
  step('Checkout idempotency: same batch returns one checkout');
  const batchId = randomUUID();
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const first = await upsertCheckout(pg, batchId);
    const second = await upsertCheckout(pg, batchId);
    assert(first === second, '同批重送回傳相同 checkout_id');

    const ids = await Promise.all(Array.from({ length: 8 }, () => upsertCheckout(pg, batchId)));
    assert(ids.every((id) => id === first), '並發 get-or-create 皆收斂到同一 checkout_id');

    const count = await pg.query(
      `SELECT COUNT(*)::int AS n FROM checkout_sessions WHERE enrollment_batch_id = $1`,
      [batchId],
    );
    assert(count.rows[0].n === 1, `DB 僅存在一筆 checkout_sessions，實際 ${count.rows[0].n}`);

    const parents = await pg.query(`SELECT id FROM parents ORDER BY created_at, id LIMIT 2`);
    if (parents.rowCount >= 2) {
      const groupBatch = randomUUID();
      const a1 = await upsertCheckout(pg, groupBatch, parents.rows[0].id);
      const a2 = await upsertCheckout(pg, groupBatch, parents.rows[0].id);
      const b1 = await upsertCheckout(pg, groupBatch, parents.rows[1].id);
      assert(a1 === a2, '同家長同團報 batch 仍收斂到同一 checkout_id');
      assert(a1 !== b1, '同團報 batch 不同家長會建立不同 checkout_id');
      const groupCount = await pg.query(
        `SELECT COUNT(*)::int AS n FROM checkout_sessions WHERE enrollment_batch_id = $1`,
        [groupBatch],
      );
      assert(groupCount.rows[0].n === 2, `同團報 batch 有兩張 parent-scoped checkout，實際 ${groupCount.rows[0].n}`);
      await pg.query(`DELETE FROM checkout_sessions WHERE enrollment_batch_id = $1`, [groupBatch]).catch(() => {});
    } else {
      console.log('  ⚠ parents 少於 2 筆，略過 parent-scoped group batch 檢查');
    }
  } finally {
    await pg.query(`DELETE FROM checkout_sessions WHERE enrollment_batch_id = $1`, [batchId]).catch(() => {});
    await pg.end();
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
