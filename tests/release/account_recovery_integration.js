'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { pool } = require('../../server/models/db');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const { getSecret } = require('../../server/middlewares/adminAuth');
const parentSync = require('../../server/services/parentSync');
const ragic = require('../../server/services/ragic');
const {
  requestAccountRecovery,
  completeManualAccountRecovery,
  AccountRecoveryError,
  __test__,
} = require('../../server/services/parentAccountRecovery');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');

const suffix = `${Date.now()}`.slice(-7);
const phone = `091${suffix}`;
const sourceId = `ZZ6504${suffix}`;
const oldUid = `Uold${crypto.randomBytes(12).toString('hex')}`;
const remoteOldUid = `Uremoteold${crypto.randomBytes(10).toString('hex')}`;
const newUid = `Unew${crypto.randomBytes(12).toString('hex')}`;
let parentId;
let studentId;
let requestId;

async function cleanup() {
  const requests = await pool.query(
    `SELECT id,claim_id FROM parent_account_recovery_requests
      WHERE ragic_record_id=$1 OR canonical_parent_id=$2`, [sourceId, parentId || null]
  );
  const requestIds = requests.rows.map((row) => row.id);
  const claimIds = requests.rows.map((row) => row.claim_id).filter(Boolean);
  if (requestIds.length) {
    await pool.query(`DELETE FROM parent_account_recovery_events WHERE recovery_request_id=ANY($1::uuid[])`, [requestIds]);
    await pool.query(`DELETE FROM parent_line_uid_rebind_audit WHERE recovery_request_id=ANY($1::uuid[])`, [requestIds]);
    await pool.query(`DELETE FROM parent_account_recovery_requests WHERE id=ANY($1::uuid[])`, [requestIds]);
  }
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  } else {
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE source_record_id=$1`, [sourceId]);
    await pool.query(`DELETE FROM identity_claim_events e USING identity_claims c WHERE e.claim_id=c.id AND c.source_record_id=$1`, [sourceId]);
    await pool.query(`DELETE FROM identity_claims WHERE source_record_id=$1`, [sourceId]);
  }
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id=$1`, [sourceId]);
  await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [parentId || null]);
  await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id=$1`, [sourceId]);
  if (parentId) {
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
}

async function setup() {
  const parent = (await pool.query(
    `INSERT INTO parents(phone,name,line_uid,ragic_record_id,is_active)
     VALUES ($1,'6504 recovery fixture',$2,$3,TRUE) RETURNING *`,
    [phone, oldUid, sourceId]
  )).rows[0];
  parentId = parent.id;
  const student = (await pool.query(
    `INSERT INTO students(parent_id,name,is_active) VALUES ($1,'恢復測試學員',TRUE) RETURNING *`,
    [parentId]
  )).rows[0];
  studentId = student.id;
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
     VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`,
    [sourceId, JSON.stringify({ _ragicId: sourceId, 1006846: remoteOldUid })]
  );
  await pool.query(
    `INSERT INTO source_record_links
       (source_system,source_table,source_record_id,canonical_parent_id,canonical_student_id,link_method)
     VALUES ('RAGIC','Z01',$1,$2,$3,'TEST_EXACT_SOURCE')`, [sourceId, parentId, studentId]
  );
  return parent;
}

async function requestThroughActiveLiffApi() {
  const originalAxiosPost = axios.post;
  const originalGetParentByPhone = ragic.getParentByPhone;
  const originalParseStudents = ragic.parseZ01Students;
  process.env.LINE_LOGIN_CHANNEL_ID = 'recovery-test-channel';
  axios.post = async () => ({ status: 200, data: { sub: newUid, aud: 'recovery-test-channel' } });
  ragic.getParentByPhone = async () => ({
    _ragicId: sourceId,
    1001100: phone,
    1001101: '6504 recovery fixture',
    1006846: remoteOldUid,
  });
  ragic.parseZ01Students = () => [{ name: '恢復測試學員', registered_phone: phone }];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../server/routes/auth'));
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/auth/parent-bind-phone`;
    const first = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id_token: 'recovery-api-token', phone }),
    });
    const firstBody = await first.json();
    assert.strictEqual(first.status, 200);
    assert.strictEqual(firstBody.status, 'need_claim_verification');

    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id_token: 'recovery-api-token', phone,
        claim: { student_name: '恢復測試學員', phone },
      }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 409);
    assert.strictEqual(body.code, 'ACCOUNT_RECOVERY_REQUIRED');
    assert.strictEqual(body.loginAllowed, false);
    assert.ok(body.recovery_request_id);
    assert.ok(body.recovery_token);
    return body;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    axios.post = originalAxiosPost;
    ragic.getParentByPhone = originalGetParentByPhone;
    ragic.parseZ01Students = originalParseStudents;
  }
}

async function run() {
  await cleanup();
  const parent = await setup();
  const preReleaseToken = signParentToken({ parentId, phone, lineUid: oldUid });
  const initial = await requestThroughActiveLiffApi();
  requestId = initial.recovery_request_id;
  assert.strictEqual(initial.code, 'ACCOUNT_RECOVERY_REQUIRED');
  assert.ok(initial.recovery_token);
  assert.strictEqual((await parentSync.findActiveParentByLineUid(oldUid)).id, parentId,
    'unverified request must not overwrite old UID');

  const replayRequest = await requestAccountRecovery({
    phone,
    studentName: '恢復測試學員',
    newLineUid: newUid,
    ragicRecordId: sourceId,
    initiatedBy: 'release-test-parent',
  });
  assert.strictEqual(replayRequest.recovery_request_id, requestId);
  assert.strictEqual(replayRequest.replayed, true);
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int AS n FROM parent_account_recovery_requests WHERE canonical_parent_id=$1`, [parentId]
  )).rows[0].n, 1);

  await assert.rejects(
    () => completeManualAccountRecovery({
      recoveryRequestId: requestId,
      recoveryToken: 'invalid-token',
      approvedBy: 'release-admin', reason: 'invalid attempt', evidenceReference: 'case:invalid',
    }),
    (err) => err instanceof AccountRecoveryError && err.code === 'ACCOUNT_RECOVERY_REQUIRED'
  );
  assert.strictEqual((await parentSync.findActiveParentByLineUid(oldUid)).id, parentId);

  // A changed identity must roll the complete rebind back, preserve the old UID,
  // and leave an auditable FAILED state. Restoring the verified evidence permits
  // a fresh high-risk verification attempt with the still-unconsumed token.
  await pool.query(`UPDATE students SET name='恢復測試學員（已變更）' WHERE id=$1`, [studentId]);
  await assert.rejects(
    () => completeManualAccountRecovery({
      recoveryRequestId: requestId,
      recoveryToken: initial.recovery_token,
      approvedBy: 'release-admin', reason: 'identity changed guard', evidenceReference: 'case:changed',
    }),
    (err) => err instanceof AccountRecoveryError && err.code === 'IDENTITY_NOT_FOUND'
  );
  assert.strictEqual((await pool.query(
    `SELECT state FROM parent_account_recovery_requests WHERE id=$1`, [requestId]
  )).rows[0].state, 'ACCOUNT_RECOVERY_FAILED');
  assert.strictEqual((await parentSync.findActiveParentByLineUid(oldUid)).id, parentId);
  assert.strictEqual(await parentSync.findActiveParentByLineUid(newUid), null);
  await pool.query(`UPDATE students SET name='恢復測試學員' WHERE id=$1`, [studentId]);

  const results = await Promise.all([
    completeManualAccountRecovery({
      recoveryRequestId: requestId,
      recoveryToken: initial.recovery_token,
      approvedBy: 'release-admin', reason: 'phone and student ownership manually verified',
      evidenceReference: 'support-case:ZZ6504',
    }),
    completeManualAccountRecovery({
      recoveryRequestId: requestId,
      recoveryToken: initial.recovery_token,
      approvedBy: 'release-admin', reason: 'phone and student ownership manually verified',
      evidenceReference: 'support-case:ZZ6504',
    }),
  ]);
  assert.strictEqual(results.filter((row) => !row.replayed).length, 1, 'concurrent recovery must commit once');
  assert.strictEqual(results.filter((row) => row.replayed).length, 1, 'concurrent loser must be idempotent replay');
  await assert.rejects(
    () => completeManualAccountRecovery({
      recoveryRequestId: requestId,
      recoveryToken: 'invalid-post-commit-replay',
      approvedBy: 'release-admin', reason: 'replay guard', evidenceReference: 'case:replay',
    }),
    (err) => err instanceof AccountRecoveryError && err.code === 'ACCOUNT_RECOVERY_LOCKED'
  );
  assert.strictEqual((await parentSync.findActiveParentByLineUid(newUid)).id, parentId);
  assert.strictEqual(await parentSync.findActiveParentByLineUid(oldUid), null, 'old UID cannot issue a new session');
  assert.strictEqual(jwt.verify(preReleaseToken, getSecret()).parentId, parentId,
    'already-issued old token follows existing natural-expiry policy');

  const state = (await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM parent_line_uid_bindings WHERE canonical_parent_id=$1 AND status='ACTIVE') active_bindings,
       (SELECT COUNT(*)::int FROM parent_line_uid_bindings WHERE canonical_parent_id=$1 AND status='REPLACED') replaced_bindings,
       (SELECT COUNT(*)::int FROM parent_line_uid_rebind_audit WHERE recovery_request_id=$2) audits,
       (SELECT COUNT(*)::int FROM ragic_sync_outbox WHERE idempotency_key=$3) outbox`,
    [parentId, requestId, `rebind-z01-line-uid:${requestId}`]
  )).rows[0];
  assert.deepStrictEqual(state, { active_bindings: 1, replaced_bindings: 1, audits: 1, outbox: 1 });
  const audit = (await pool.query(
    `SELECT * FROM parent_line_uid_rebind_audit WHERE recovery_request_id=$1`, [requestId]
  )).rows[0];
  for (const key of [
    'canonical_parent_id','ragic_record_id','old_uid_hash','new_uid_hash','verification_method',
    'verification_reference','initiated_by','approved_by','reason','correlation_id',
    'requested_at','verified_at','committed_at','ragic_sync_state',
  ]) assert.ok(audit[key], `audit.${key} is required`);
  assert.strictEqual(audit.old_uid_hash.trim(), __test__.sha256(oldUid));
  assert.strictEqual(audit.new_uid_hash.trim(), __test__.sha256(newUid));

  const outboxKey = `rebind-z01-line-uid:${requestId}`;
  const timeout = await processRagicSyncOutbox({
    limit: 1,
    idempotencyKey: outboxKey,
    schemaGuard: async () => ({ verified: true }),
    writer: async () => { const err = new Error('simulated timeout'); err.code = 'RAGIC_TIMEOUT'; throw err; },
  });
  assert.deepStrictEqual(timeout, { processed: 1, synced: 0, retryable: 1, blocked: 0 });
  assert.strictEqual((await parentSync.findActiveParentByLineUid(newUid)).id, parentId,
    'Ragic timeout must not roll back local rebind');
  await pool.query(`UPDATE ragic_sync_outbox SET next_retry_at=NOW() WHERE idempotency_key=$1`, [outboxKey]);
  let writes = 0;
  const success = await processRagicSyncOutbox({
    limit: 1,
    idempotencyKey: outboxKey,
    schemaGuard: async () => ({ verified: true }),
    writer: async (payload, recordId) => {
      writes += 1;
      assert.deepStrictEqual(Object.keys(payload), ['1006846']);
      assert.strictEqual(payload['1006846'], newUid);
      assert.strictEqual(recordId, sourceId);
    },
  });
  assert.deepStrictEqual(success, { processed: 1, synced: 1, retryable: 0, blocked: 0 });
  assert.strictEqual(writes, 1);
  const duplicate = await processRagicSyncOutbox({
    limit: 1, idempotencyKey: outboxKey, schemaGuard: async () => ({ verified: true }),
  });
  assert.deepStrictEqual(duplicate, { processed: 0, synced: 0, retryable: 0, blocked: 0 });
  const previousRateLimit = process.env.PARENT_ACCOUNT_RECOVERY_RATE_LIMIT_MAX;
  process.env.PARENT_ACCOUNT_RECOVERY_RATE_LIMIT_MAX = '1';
  await assert.rejects(
    () => requestAccountRecovery({
      phone,
      studentName: '恢復測試學員',
      newLineUid: `${newUid}-another`,
      ragicRecordId: sourceId,
      initiatedBy: 'release-test-rate-limit',
    }),
    (err) => err instanceof AccountRecoveryError
      && err.code === 'ACCOUNT_RECOVERY_LOCKED' && err.http === 429
  );
  if (previousRateLimit == null) delete process.env.PARENT_ACCOUNT_RECOVERY_RATE_LIMIT_MAX;
  else process.env.PARENT_ACCOUNT_RECOVERY_RATE_LIMIT_MAX = previousRateLimit;
  console.log('account_recovery_integration: PASS (active LIFF API, unverified guard, failed rollback audit, manual proof, atomic rebind, replay, concurrency, rate limit, timeout, audit)');
}

(async () => {
  try { await run(); } finally { await cleanup(); await pool.end(); }
})().catch((err) => { console.error(err); process.exit(1); });
