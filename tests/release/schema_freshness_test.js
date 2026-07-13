'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../../server/models/db');
const parentSync = require('../../server/services/parentSync');
const {
  extractSchemaEvidence,
  verifyRagicZ01UidSchemaFreshness,
  assertRagicZ01UidSchemaFresh,
} = require('../../server/services/ragicSchemaFreshness');
const { registerNewParentLocalFirst } = require('../../server/services/z03IdentityClaim');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');

function definition(name = '家教系統uid', include = true) {
  return {
    version: 'release-test-v1',
    fields: include ? {
      fid1006846: { name, attr_noDup: 'true', attr_must: 'false', attr_ro: 'false' },
      fid1002390: { name: 'line對話網址' },
    } : { fid1002390: { name: 'line對話網址' } },
  };
}

function fakeFetch(data) {
  return async () => ({
    fetchedAt: new Date('2026-07-13T14:00:00Z'),
    endpoint: 'https://example.invalid/z01?api&def=1',
    sheetPath: 'https://example.invalid/z01',
    httpStatus: 200,
    data,
    responseMetadata: { etag: 'release-test' },
  });
}

function captureDb() {
  const rows = [];
  return {
    rows,
    query: async (_sql, params) => { rows.push(params); return { rows: [] }; },
  };
}

async function unitSchemaCases() {
  const exact = extractSchemaEvidence(definition());
  assert.deepStrictEqual(
    { verified: exact.verified, id: exact.fieldId, name: exact.fieldName, noDup: exact.attrNoDup, must: exact.attrMust, ro: exact.attrRo },
    { verified: true, id: '1006846', name: '家教系統uid', noDup: true, must: false, ro: false }
  );
  assert.strictEqual(extractSchemaEvidence(definition('家教系統uid', false)).verified, false,
    'missing field 1006846 must block');
  assert.strictEqual(extractSchemaEvidence(definition('LINE 對話網址')).verified, false,
    'wrong field name must block');
  const nonUnique = definition();
  nonUnique.fields.fid1006846.attr_noDup = 'false';
  assert.strictEqual(extractSchemaEvidence(nonUnique).failureCode, 'RAGIC_UID_FIELD_NOT_UNIQUE',
    'non-unique UID field cannot satisfy the identity write contract');

  const goodDb = captureDb();
  const good = await verifyRagicZ01UidSchemaFreshness({
    fetchDefinition: fakeFetch(definition()), db: goodDb, ttlMs: 60_000,
    correlationId: '00000000-0000-4000-8000-000000000010',
  });
  assert.strictEqual(good.verified, true);
  assert.strictEqual(good.http_status, 200);
  assert.strictEqual(good.field_id, '1006846');
  assert.ok(/^[a-f0-9]{64}$/.test(good.response_hash));
  assert.strictEqual(goodDb.rows.length, 1, 'fresh response evidence must be persisted');

  for (const badDefinition of [definition('家教系統uid', false), definition('LINE 對話網址')]) {
    const db = captureDb();
    const evidence = await verifyRagicZ01UidSchemaFreshness({ fetchDefinition: fakeFetch(badDefinition), db });
    assert.strictEqual(evidence.verified, false);
    assert.strictEqual(evidence.failure_code, 'RAGIC_UID_FIELD_SCHEMA_MISMATCH');
    assert.strictEqual(db.rows.length, 1, 'mismatch evidence must still be auditable');
  }
  await assert.rejects(
    () => assertRagicZ01UidSchemaFresh({
      db: { query: async () => ({ rows: [{
        verified: true,
        fetched_at: new Date('2026-07-13T13:00:00Z'),
        expires_at: new Date('2026-07-13T13:15:00Z'),
        response_hash: 'a'.repeat(64),
      }] }) },
      now: new Date('2026-07-13T14:00:00Z'),
    }),
    (err) => err.code === 'RAGIC_SCHEMA_NOT_VERIFIED'
  );
}

async function workerAndLocalLoginCases() {
  const nonexistentKey = `schema-no-job-${crypto.randomUUID()}`;
  const allowed = await processRagicSyncOutbox({
    limit: 1, idempotencyKey: nonexistentKey, schemaGuard: async () => ({ verified: true }),
  });
  assert.deepStrictEqual(allowed, { processed: 0, synced: 0, retryable: 0, blocked: 0 });
  const blocked = await processRagicSyncOutbox({
    limit: 1,
    idempotencyKey: nonexistentKey,
    schemaGuard: async () => { const err = new Error('stale'); err.code = 'RAGIC_SCHEMA_NOT_VERIFIED'; throw err; },
  });
  assert.deepStrictEqual(blocked, {
    processed: 0, synced: 0, retryable: 0, blocked: 1,
    skipped: true, reason: 'RAGIC_SCHEMA_NOT_VERIFIED',
  });

  const suffix = `${Date.now()}`.slice(-6);
  const phone = `0933${suffix}`;
  const lineUid = `Uschema${crypto.randomBytes(12).toString('hex')}`;
  const requestKey = `schema-local-${suffix}`;
  let parentId = null;
  try {
    const local = await registerNewParentLocalFirst({
      parent: { name: 'schema blocked local parent', phone },
      students: [{ name: 'schema local student' }],
      lineUid,
      idempotencyKey: requestKey,
    });
    parentId = local.parent.id;
    assert.strictEqual(local.sync_state, 'SYNC_PENDING');
    const blockedOutbox = await processRagicSyncOutbox({
      limit: 1,
      idempotencyKey: `create-z01-parent:${requestKey}`,
      schemaGuard: async () => { const err = new Error('mismatch'); err.code = 'RAGIC_SCHEMA_NOT_VERIFIED'; throw err; },
    });
    assert.strictEqual(blockedOutbox.reason, 'RAGIC_SCHEMA_NOT_VERIFIED');
    assert.strictEqual((await parentSync.findActiveParentByLineUid(lineUid)).id, parentId,
      'schema block must not prevent local login');
    const request = (await pool.query(
      `SELECT state FROM parent_identity_requests WHERE idempotency_key=$1`, [requestKey]
    )).rows[0];
    assert.strictEqual(request.state, 'SYNC_PENDING', 'local new parent remains SYNC_PENDING');
  } finally {
    const claims = await pool.query(
      `SELECT id FROM identity_claims WHERE source_record_id=$1`, [`PENDING:${requestKey}`]
    );
    const claimIds = claims.rows.map((row) => row.id);
    if (claimIds.length) {
      await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
      await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
      await pool.query(`DELETE FROM parent_identity_requests WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
      await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
    }
    if (parentId) {
      await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
      await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [parentId]);
      await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
    }
  }
}

(async () => {
  try {
    await unitSchemaCases();
    await workerAndLocalLoginCases();
    console.log('schema_freshness_test: PASS (live evidence contract, missing/name/stale block, worker gate, local login)');
  } finally {
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
