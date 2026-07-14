'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');
const parentSync = require('../../server/services/parentSync');
const { claimZ03Identity } = require('../../server/services/z03IdentityClaim');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');

const suffix = String(Date.now()).slice(-6);
const sourceId = `98${suffix}`;
const phone = `0948${suffix}`;
const lineUid = `UstoredError${crypto.randomBytes(12).toString('hex')}`;
const studentName = '既有部分資料學員';
let parentId = null;

async function cleanup() {
  const claims = await pool.query(
    `SELECT id,canonical_parent_id FROM identity_claims WHERE source_record_id=$1`, [sourceId]
  );
  const claimIds = claims.rows.map((row) => row.id);
  parentId = parentId || claims.rows.find((row) => row.canonical_parent_id)?.canonical_parent_id || null;
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
  }
  await pool.query(`DELETE FROM parent_identity_backoffice_tasks WHERE source_record_ids && ARRAY[$1]::text[]`, [sourceId]);
  await pool.query(`DELETE FROM parent_profile_patch_audit WHERE source_record_id=$1`, [sourceId]);
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id=$1`, [sourceId]);
  if (claimIds.length) await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [sourceId]);
  await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id=$1`, [sourceId]);
  if (parentId) {
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
}

async function loginThroughHttpRoute() {
  const originalAxiosPost = axios.post;
  const originalRagic = {};
  let ragicCalls = 0;
  for (const name of ['getParentByPhone', 'getParentByLineUid', 'upsertParentStrict', 'createParentWithStudentsInRagic']) {
    originalRagic[name] = ragic[name];
    ragic[name] = async () => {
      ragicCalls++;
      throw new Error('unexpected synchronous Ragic call during local login');
    };
  }
  axios.post = async () => ({ status: 200, data: { sub: lineUid, aud: 'stored-error-channel' } });
  process.env.LINE_LOGIN_CHANNEL_ID = 'stored-error-channel';
  process.env.EXISTING_USER_LOCAL_FASTPATH = 'true';
  process.env.PARENT_IDENTITY_RESOLVER_V2 = 'true';
  delete require.cache[require.resolve('../../server/services/lineAuth')];
  delete require.cache[require.resolve('../../server/routes/auth')];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../server/routes/auth'));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/parent-line-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: 'stored-error-login-token' }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.status, 'logged_in');
    assert.strictEqual(body.local_fast_path, true);
    assert.strictEqual(body.parent.id, parentId);
    assert.ok(body.token);
    assert.strictEqual(ragicCalls, 0, 'persisted sync error must not add a synchronous Ragic login dependency');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    axios.post = originalAxiosPost;
    Object.assign(ragic, originalRagic);
    delete process.env.EXISTING_USER_LOCAL_FASTPATH;
    delete process.env.PARENT_IDENTITY_RESOLVER_V2;
  }
}

(async () => {
  await cleanup();
  try {
    const family = (await pool.query(
      `INSERT INTO ragic_z03_records
         (z01_ragic_record_id,raw_name,phone,phone_canonical,email_raw,status,classification,reason_code,claim_state)
       VALUES ($1,'已有姓名',$2,$2,'','pending','PENDING_Z03','TRUE_LINE_UID_EMPTY','UNRESOLVED') RETURNING id`,
      [sourceId, phone]
    )).rows[0];
    await pool.query(
      `INSERT INTO ragic_z03_students
         (z03_record_id,name_raw,name_normalized,source_row_key,classification,present_in_latest_payload)
       VALUES ($1,$2,$2,'existing-row','VALID',TRUE)`,
      [family.id, studentName]
    );
    await pool.query(
      `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
       VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`,
      [sourceId, JSON.stringify({ _ragicId: sourceId, 1001101: '已有姓名', 1001100: phone, 1006846: '' })]
    );

    const claimed = await claimZ03Identity({
      phone,
      studentName,
      studentInput: { name: studentName },
      lineUid,
      parentProfile: { name: '已有姓名', phone, email: 'completed@example.com' },
      allowStudentAppend: true,
      ownershipVerified: true,
    });
    parentId = claimed.parent.id;
    assert.strictEqual(claimed.sync_state, 'SYNC_PENDING');
    const job = (await pool.query(
      `SELECT * FROM ragic_sync_outbox WHERE source_record_id=$1 AND operation='BIND_Z01_LINE_UID'`,
      [sourceId]
    )).rows[0];
    assert.ok(job);

    const firstAttempt = await processRagicSyncOutbox({
      limit: 1,
      idempotencyKey: job.idempotency_key,
      schemaGuard: async () => ({ verified: true }),
      reader: async () => ({ _ragicId: sourceId, 1006846: '', 1002820: '' }),
      writer: async () => {
        const err = new Error('simulated stored network error');
        err.code = 'RAGIC_NETWORK_ERROR';
        throw err;
      },
    });
    assert.deepStrictEqual(firstAttempt, { processed: 1, synced: 0, retryable: 1, blocked: 0 });
    const storedError = (await pool.query(
      `SELECT o.state,o.attempts,o.last_error_code,o.sanitized_error,
              c.state AS claim_state,z.claim_state AS z03_claim_state
         FROM ragic_sync_outbox o
         JOIN identity_claims c ON c.id=o.claim_id
         JOIN ragic_z03_records z ON z.z01_ragic_record_id=o.source_record_id
        WHERE o.id=$1`, [job.id]
    )).rows[0];
    assert.strictEqual(storedError.state, 'retryable');
    assert.strictEqual(storedError.attempts, 1);
    assert.strictEqual(storedError.last_error_code, 'RAGIC_NETWORK_ERROR');
    assert.deepStrictEqual(JSON.parse(storedError.sanitized_error), {
      code: 'RAGIC_NETWORK_ERROR', http_status: null,
    });
    assert.strictEqual(storedError.claim_state, 'SYNC_FAILED_RETRYABLE');
    assert.strictEqual(storedError.z03_claim_state, 'SYNC_FAILED_RETRYABLE');

    await loginThroughHttpRoute();
    assert.strictEqual((await parentSync.findActiveParentByLineUid(lineUid)).id, parentId);

    await pool.query(
      `UPDATE ragic_sync_outbox
          SET next_retry_at=NOW(),payload_reference=jsonb_set(payload_reference,'{verify_readback}','true'::jsonb)
        WHERE id=$1`, [job.id]
    );
    const remote = { _ragicId: sourceId, 1006846: '', 1002820: '' };
    let writeCalls = 0;
    let sawMetadataOptIn = false;
    const recovered = await processRagicSyncOutbox({
      limit: 1,
      idempotencyKey: job.idempotency_key,
      schemaGuard: async () => ({ verified: true }),
      reader: async () => ({ ...remote }),
      writer: async (patch, recordId, options) => {
        writeCalls++;
        assert.strictEqual(recordId, sourceId);
        assert.strictEqual(patch['1006846'], lineUid);
        assert.strictEqual(patch['1002820'], 'completed@example.com');
        sawMetadataOptIn = options.includeResponseMetadata === true;
        Object.assign(remote, patch);
        return { data: { status: 'SUCCESS' }, responseMetadata: { httpStatus: 200 } };
      },
    });
    assert.deepStrictEqual(recovered, { processed: 1, synced: 1, retryable: 0, blocked: 0 });
    assert.strictEqual(writeCalls, 1);
    assert.strictEqual(sawMetadataOptIn, true);
    assert.strictEqual(remote['1006846'], lineUid);
    assert.strictEqual(remote['1002820'], 'completed@example.com');

    const final = (await pool.query(
      `SELECT o.state,o.attempts,o.last_error_code,o.sanitized_error,
              c.state AS claim_state,z.claim_state AS z03_claim_state
         FROM ragic_sync_outbox o
         JOIN identity_claims c ON c.id=o.claim_id
         JOIN ragic_z03_records z ON z.z01_ragic_record_id=o.source_record_id
        WHERE o.id=$1`, [job.id]
    )).rows[0];
    assert.deepStrictEqual(final, {
      state: 'synced', attempts: 2, last_error_code: null, sanitized_error: null,
      claim_state: 'SYNCED', z03_claim_state: 'SYNCED',
    });
    await loginThroughHttpRoute();
    console.log('z03_persisted_error_recovery_test: PASS (partial data, stored ERROR, local login, HTTP 200 write/readback, synced recovery)');
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
