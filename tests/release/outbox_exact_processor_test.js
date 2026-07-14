'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../../server/models/db');
const { claimZ03Identity } = require('../../server/services/z03IdentityClaim');
const {
  processRagicSyncOutboxJob,
  readbackRagicSyncOutboxJob,
} = require('../../server/services/ragicSyncOutbox');

const suffix = String(Date.now()).slice(-6);
const fixtures = [0, 1, 2, 3].map((offset) => ({
  sourceId: String(970000000 + Number(suffix) * 10 + offset),
  phone: `095${offset}${suffix}`,
  studentName: `單筆處理學員${offset}`,
  lineUid: `Uexact${offset}${crypto.randomBytes(12).toString('hex')}`,
  parentId: null,
}));

async function cleanup(fixture) {
  const claims = await pool.query(
    `SELECT id,canonical_parent_id FROM identity_claims WHERE source_record_id=$1`, [fixture.sourceId]
  );
  const claimIds = claims.rows.map((row) => row.id);
  fixture.parentId = fixture.parentId || claims.rows.find((row) => row.canonical_parent_id)?.canonical_parent_id || null;
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
  }
  await pool.query(`DELETE FROM parent_identity_backoffice_tasks WHERE source_record_ids && ARRAY[$1]::text[]`, [fixture.sourceId]);
  await pool.query(`DELETE FROM parent_profile_patch_audit WHERE source_record_id=$1`, [fixture.sourceId]);
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id=$1`, [fixture.sourceId]);
  if (claimIds.length) await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [fixture.sourceId]);
  await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id=$1`, [fixture.sourceId]);
  if (fixture.parentId) {
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [fixture.parentId]);
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [fixture.parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [fixture.parentId]);
  }
}

async function setup(fixture) {
  await cleanup(fixture);
  const family = (await pool.query(
    `INSERT INTO ragic_z03_records
       (z01_ragic_record_id,raw_name,phone,phone_canonical,status,classification,reason_code,claim_state)
     VALUES ($1,'exact processor',$2,$2,'pending','PENDING_Z03','TRUE_LINE_UID_EMPTY','UNRESOLVED') RETURNING id`,
    [fixture.sourceId, fixture.phone]
  )).rows[0];
  await pool.query(
    `INSERT INTO ragic_z03_students
       (z03_record_id,name_raw,name_normalized,source_row_key,classification,present_in_latest_payload)
     VALUES ($1,$2,$2,'row-1','VALID',TRUE)`,
    [family.id, fixture.studentName]
  );
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
     VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`,
    [fixture.sourceId, JSON.stringify({ _ragicId: fixture.sourceId, 1006846: '' })]
  );
  const claim = await claimZ03Identity({
    phone: fixture.phone,
    studentName: fixture.studentName,
    lineUid: fixture.lineUid,
    parentName: `單筆處理家長${fixture.sourceId}`,
  });
  fixture.parentId = claim.parent.id;
  return (await pool.query(
    `SELECT * FROM ragic_sync_outbox WHERE source_record_id=$1 AND operation='BIND_Z01_LINE_UID'`,
    [fixture.sourceId]
  )).rows[0];
}

function exactOptions(job, fixture, overrides = {}) {
  return {
    jobId: job.id,
    idempotencyKey: job.idempotency_key,
    sourceRecordId: fixture.sourceId,
    targetRecordId: fixture.sourceId,
    operation: 'BIND_Z01_LINE_UID',
    schemaGuard: async () => ({ verified: true }),
    ...overrides,
  };
}

(async () => {
  for (const fixture of fixtures) await cleanup(fixture);
  try {
    const firstJob = await setup(fixtures[0]);
    const secondJob = await setup(fixtures[1]);
    const originalConsoleError = console.error;
    console.error = () => {};
    let schemaBlocked;
    try {
      schemaBlocked = await processRagicSyncOutboxJob(exactOptions(secondJob, fixtures[1], {
        schemaGuard: async () => {
          const err = new Error('stale');
          err.code = 'RAGIC_SCHEMA_NOT_VERIFIED';
          throw err;
        },
      }));
    } finally {
      console.error = originalConsoleError;
    }
    assert.strictEqual(schemaBlocked.status, 'SCHEMA_BLOCKED');
    assert.deepStrictEqual(
      (await pool.query(`SELECT state,attempts FROM ragic_sync_outbox WHERE id=$1`, [secondJob.id])).rows[0],
      { state: 'pending', attempts: 0 },
      'schema guard must stop before claim'
    );
    const remote = new Map();
    let writerCalls = 0;
    const reader = async (node) => ({ _ragicId: String(node), 1006846: remote.get(String(node)) || '' });
    const writer = async (patch, node, options) => {
      writerCalls++;
      assert.strictEqual(options.includeResponseMetadata, true);
      remote.set(String(node), patch['1006846']);
      return { data: { status: 'SUCCESS' }, responseMetadata: { httpStatus: 200 } };
    };
    const first = await processRagicSyncOutboxJob(exactOptions(firstJob, fixtures[0], { reader, writer }));
    assert.strictEqual(first.status, 'SYNCED');
    assert.strictEqual(first.write_performed, true);
    assert.strictEqual(first.http_status, 200);
    assert.strictEqual(first.readback_verified, true);
    assert.strictEqual(first.final_job_state, 'synced');
    assert.deepStrictEqual(
      (await pool.query(`SELECT state,attempts FROM ragic_sync_outbox WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[firstJob.id, secondJob.id]])).rows.reduce((map, row) => ({ ...map, [row.state]: row.attempts }), {}),
      { pending: 0, synced: 1 },
      'processing one exact Node must not claim the other Node'
    );
    const duplicate = await processRagicSyncOutboxJob(exactOptions(firstJob, fixtures[0], { reader, writer }));
    assert.strictEqual(duplicate.status, 'NOT_CLAIMED');
    assert.strictEqual(writerCalls, 1, 'repeat must not write again');
    const syncedJob = (await pool.query(`SELECT * FROM ragic_sync_outbox WHERE id=$1`, [firstJob.id])).rows[0];
    assert.strictEqual((await readbackRagicSyncOutboxJob({ job: syncedJob, reader })).readback_verified, true);

    const mismatchJob = await setup(fixtures[2]);
    const mismatch = await processRagicSyncOutboxJob(exactOptions(mismatchJob, fixtures[2], {
      reader: async (node) => ({ _ragicId: String(node), 1006846: '' }),
      writer: async () => ({ data: { status: 'SUCCESS' }, responseMetadata: { httpStatus: 200 } }),
    }));
    assert.strictEqual(mismatch.status, 'FAILED');
    assert.strictEqual(mismatch.final_job_state, 'blocked_schema');
    assert.strictEqual(mismatch.error_code, 'RAGIC_UNCONFIRMED_WRITE');
    assert.strictEqual(mismatch.readback_verified, false);

    const retryJob = await setup(fixtures[3]);
    const retry = await processRagicSyncOutboxJob(exactOptions(retryJob, fixtures[3], {
      reader: async (node) => ({ _ragicId: String(node), 1006846: '' }),
      writer: async () => {
        const err = new Error('network');
        err.code = 'RAGIC_NETWORK_ERROR';
        throw err;
      },
    }));
    assert.strictEqual(retry.status, 'FAILED');
    assert.strictEqual(retry.final_job_state, 'retryable');
    assert.strictEqual(retry.error_code, 'RAGIC_NETWORK_ERROR');
    console.log('outbox_exact_processor_test: PASS (exact isolation, HTTP metadata, readback, repeat, failure states)');
  } finally {
    for (const fixture of fixtures) await cleanup(fixture);
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
