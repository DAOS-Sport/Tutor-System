'use strict';

const assert = require('assert');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');
const parentSync = require('../../server/services/parentSync');
const { registerNewParentLocalFirst } = require('../../server/services/z03IdentityClaim');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');

const suffix = String(Date.now()).slice(-6);
const phone = `0922${suffix}`;
const lineUid = `Ulocalfirst${suffix}`;
const requestKey = `parent-registration-${suffix}`;
const outboxKey = `create-z01-parent:${requestKey}`;
const remoteRecordId = `98${suffix}`;

async function cleanup() {
  const claims = await pool.query(
    `SELECT id,canonical_parent_id FROM identity_claims
      WHERE source_record_id IN ($1,$2) OR correlation_id IN (
        SELECT correlation_id FROM parent_identity_requests WHERE idempotency_key=$3
      )`,
    [`PENDING:${requestKey}`, remoteRecordId, requestKey]
  );
  const claimIds = claims.rows.map((row) => row.id);
  const parentIds = [...new Set(claims.rows.map((row) => row.canonical_parent_id).filter(Boolean))];
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM source_record_links WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM parent_identity_requests WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  }
  for (const parentId of parentIds) {
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
}

async function rightsCounts() {
  const names = ['course_period_enrollments', 'admin_enrollments', 'group_orders', 'group_order_members', 'checkin_records'];
  const result = {};
  for (const table of names) {
    const exists = (await pool.query(`SELECT to_regclass($1) AS name`, [table])).rows[0].name;
    if (exists) result[table] = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count);
  }
  return result;
}

(async () => {
  await cleanup();
  const beforeRights = await rightsCounts();
  const original = {
    check: ragic.checkZ01SchemaDrift,
    fetchPage: ragic.fetchPage,
    create: ragic.createParentWithStudentsInRagic,
  };
  let createCalls = 0;
  let capturedUid = null;
  let remoteExists = false;
  try {
    const first = await registerNewParentLocalFirst({
      parent: { name: '本地優先家長', phone },
      students: [{ name: '同一位學生', birth_date: '2018-01-02', gender: '生理女' }],
      lineUid,
      idempotencyKey: requestKey,
    });
    const replay = await registerNewParentLocalFirst({
      parent: { name: '本地優先家長', phone },
      students: [{ name: '同一位學生', birth_date: '2018-01-02', gender: '生理女' }],
      lineUid,
      idempotencyKey: requestKey,
    });
    assert.strictEqual(first.parent.id, replay.parent.id);
    assert.strictEqual(replay.replayed, true);
    assert.strictEqual((await parentSync.findActiveParentByLineUid(lineUid)).id, first.parent.id);
    const localCounts = (await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM parents WHERE phone=$1) AS parents,
        (SELECT COUNT(*)::int FROM students WHERE parent_id=$2) AS students,
        (SELECT COUNT(*)::int FROM ragic_sync_outbox WHERE idempotency_key=$3) AS outbox`,
      [phone, first.parent.id, outboxKey]
    )).rows[0];
    assert.deepStrictEqual(localCounts, { parents: 1, students: 1, outbox: 1 });

    ragic.checkZ01SchemaDrift = async () => ({ drifted: false, mismatches: [] });
    ragic.fetchPage = async (_form, options) => {
      assert.strictEqual(options.naming, 'EID');
      assert.strictEqual(options.where, `1006846,eq,${lineUid}`);
      return {
        rows: remoteExists ? [{ _ragicId: remoteRecordId, 1006846: lineUid }] : [],
        count: remoteExists ? 1 : 0,
      };
    };
    ragic.createParentWithStudentsInRagic = async ({ lineUid: uid }) => {
      createCalls += 1;
      capturedUid = uid;
      if (createCalls === 1) {
        remoteExists = true; // Ragic committed, but the response was lost.
        const err = new Error('offline');
        err.code = 'RAGIC_NETWORK_ERROR';
        throw err;
      }
      return { ragicRecordId: remoteRecordId };
    };

    const schemaGuard = async () => ({ verified: true });
    const timeout = await processRagicSyncOutbox({ limit: 1, idempotencyKey: outboxKey, schemaGuard });
    assert.deepStrictEqual(timeout, { processed: 1, synced: 0, retryable: 1, blocked: 0 });
    assert.ok(await parentSync.findActiveParentByLineUid(lineUid), 'Ragic timeout must not remove local login identity');
    await pool.query(`UPDATE ragic_sync_outbox SET next_retry_at=NOW() WHERE idempotency_key=$1`, [outboxKey]);
    const success = await processRagicSyncOutbox({ limit: 1, idempotencyKey: outboxKey, schemaGuard });
    assert.deepStrictEqual(success, { processed: 1, synced: 1, retryable: 0, blocked: 0 });
    assert.strictEqual(capturedUid, lineUid);
    const duplicateDelivery = await processRagicSyncOutbox({ limit: 1, idempotencyKey: outboxKey, schemaGuard });
    assert.deepStrictEqual(duplicateDelivery, { processed: 0, synced: 0, retryable: 0, blocked: 0 });
    assert.strictEqual(createCalls, 1, 'timeout replay must discover the committed record and not create again');

    const finalState = (await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM parents WHERE phone=$1) AS parents,
         (SELECT COUNT(*)::int FROM source_record_links WHERE source_record_id=$2) AS links,
         (SELECT state FROM ragic_sync_outbox WHERE idempotency_key=$3) AS outbox_state`,
      [phone, remoteRecordId, outboxKey]
    )).rows[0];
    assert.deepStrictEqual(finalState, { parents: 1, links: 1, outbox_state: 'synced' });
    assert.deepStrictEqual(await rightsCounts(), beforeRights, 'identity closure must not mutate course rights tables');
    console.log('parent_local_first_registration: PASS (idempotency, timeout login, exact UID create, rights protection)');
  } finally {
    Object.assign(ragic, {
      checkZ01SchemaDrift: original.check,
      fetchPage: original.fetchPage,
      createParentWithStudentsInRagic: original.create,
    });
    await cleanup();
    await pool.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
