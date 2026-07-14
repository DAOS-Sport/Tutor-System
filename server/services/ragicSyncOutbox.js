'use strict';

const { pool } = require('../models/db');
const ragic = require('./ragic');
const {
  RAGIC_Z01_FIELDS,
  getTrueRagicLineUid,
  STABILITY_FLAGS,
} = require('../config/ragicSchema');
const { assertRagicZ01UidSchemaFresh } = require('./ragicSchemaFreshness');
const { sanitizeAllowlistedProfilePatch } = require('./parentRegistrationProfile');
const { createParentIdentityBackofficeTask } = require('./parentIdentityBackoffice');

const RETRYABLE_CODES = new Set([
  'RAGIC_TIMEOUT',
  'RAGIC_RATE_LIMITED',
  'RAGIC_UNAVAILABLE',
  'RAGIC_NETWORK_ERROR',
  'RAGIC_HTTP_SERVER_ERROR',
  'RAGIC_RETRY_EXHAUSTED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
]);
const SCHEMA_CODES = new Set([
  'RAGIC_VALIDATION_ERROR',
  'RAGIC_APPLICATION_ERROR',
  'RAGIC_UNCONFIRMED_WRITE',
  'RAGIC_SCHEMA_VALIDATION_FAILED',
  'RAGIC_REQUIRED_FIELD_MISSING',
  'RAGIC_INVALID_OPTION',
  'RAGIC_UID_FIELD_SCHEMA_MISMATCH',
  'RAGIC_UID_FIELD_NOT_UNIQUE',
  'RAGIC_UID_FIELD_READ_ONLY',
  'RAGIC_SCHEMA_NOT_VERIFIED',
]);

function classifySyncFailure(err, attempts, maxAttempts) {
  const code = String(err?.code || 'RAGIC_SYNC_FAILED');
  const httpStatus = Number(err?.status || err?.response?.status || 0);
  const retryable = RETRYABLE_CODES.has(code) || httpStatus === 429 || httpStatus >= 500;
  if (retryable && attempts < maxAttempts) {
    return { outboxState: 'retryable', claimState: 'SYNC_FAILED_RETRYABLE', code };
  }
  if (retryable) {
    return { outboxState: 'blocked_retry_exhausted', claimState: 'SYNC_BLOCKED_DATA_CONFLICT', code: 'RAGIC_RETRY_EXHAUSTED' };
  }
  if (SCHEMA_CODES.has(code) || httpStatus === 400 || httpStatus === 422) {
    return { outboxState: 'blocked_schema', claimState: 'SYNC_BLOCKED_SCHEMA', code };
  }
  return { outboxState: 'blocked_data_conflict', claimState: 'SYNC_BLOCKED_DATA_CONFLICT', code };
}

function _sanitizedError(err, code) {
  const httpStatus = Number(err?.status || err?.response?.status || 0) || null;
  return JSON.stringify({ code, http_status: httpStatus });
}

async function _claimNextJob(idempotencyKey = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = (await client.query(
      `SELECT * FROM ragic_sync_outbox
        WHERE ($1::text IS NULL OR idempotency_key = $1)
          AND ((
          state IN ('pending','retryable') AND next_retry_at <= NOW()
        ) OR (
          state = 'processing' AND updated_at < NOW() - INTERVAL '15 minutes'
        ))
        ORDER BY next_retry_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [idempotencyKey]
    )).rows[0] || null;
    if (!job) {
      await client.query('COMMIT');
      return null;
    }
    const claimed = (await client.query(
      `UPDATE ragic_sync_outbox
          SET state='processing', attempts=attempts+1, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [job.id]
    )).rows[0];
    await client.query('COMMIT');
    return claimed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function _claimExactJob({
  jobId,
  idempotencyKey,
  sourceRecordId,
  targetRecordId,
  operation,
  requiredState = 'pending',
  requiredAttempts = 0,
}) {
  if (![jobId, idempotencyKey, sourceRecordId, targetRecordId, operation].every((value) => String(value || '').trim())) {
    const err = new Error('exact outbox claim requires job id, idempotency key, source/target record id, and operation');
    err.code = 'RAGIC_OUTBOX_EXACT_SELECTOR_REQUIRED';
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = (await client.query(
      `SELECT * FROM ragic_sync_outbox
        WHERE id=$1 AND idempotency_key=$2 AND source_record_id=$3
          AND target_record_id=$4 AND operation=$5
          AND state=$6 AND attempts=$7
        FOR UPDATE SKIP LOCKED`,
      [jobId, idempotencyKey, String(sourceRecordId), String(targetRecordId), operation,
       requiredState, Number(requiredAttempts)]
    )).rows[0] || null;
    if (!job) {
      await client.query('COMMIT');
      return null;
    }
    const claimed = (await client.query(
      `UPDATE ragic_sync_outbox
          SET state='processing', attempts=attempts+1, updated_at=NOW()
        WHERE id=$1 AND state=$2 AND attempts=$3 RETURNING *`,
      [job.id, requiredState, Number(requiredAttempts)]
    )).rows[0] || null;
    await client.query('COMMIT');
    if (claimed) {
      claimed._claimed_from_state = job.state;
      claimed._claimed_from_attempts = Number(job.attempts);
    }
    return claimed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function _markSuccess(job) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE ragic_sync_outbox
          SET state='synced', last_error_code=NULL, sanitized_error=NULL,
              completed_at=NOW(), updated_at=NOW()
        WHERE id=$1`,
      [job.id]
    );
    const isRebind = job.operation === 'REBIND_Z01_LINE_UID';
    const claim = (await client.query(
      `UPDATE identity_claims
          SET state=$2, last_error_code=NULL, updated_at=NOW(), version=version+1
        WHERE id=$1 RETURNING id, correlation_id`,
      [job.claim_id, isRebind ? 'ACCOUNT_REBOUND' : 'SYNCED']
    )).rows[0];
    if (claim) {
      await client.query(
        `INSERT INTO identity_claim_events
           (claim_id,from_state,to_state,reason_code,actor_type,correlation_id)
         VALUES ($1,$2,$3,'RAGIC_WRITE_CONFIRMED','outbox-worker',$4)`,
        [claim.id, isRebind ? 'ACCOUNT_REBIND_SYNC_PENDING' : 'SYNC_PENDING',
         isRebind ? 'ACCOUNT_REBOUND' : 'SYNCED', claim.correlation_id]
      );
    }
    if (isRebind) {
      await client.query(
        `UPDATE parent_account_recovery_requests r
            SET ragic_sync_state='SYNCED',last_error_code=NULL,updated_at=NOW()
           FROM ragic_sync_outbox o
          WHERE o.id=$1 AND r.id=(o.payload_reference->>'recovery_request_id')::uuid`,
        [job.id]
      );
      await client.query(
        `UPDATE parent_line_uid_rebind_audit a
            SET ragic_sync_state='SYNCED'
           FROM ragic_sync_outbox o
          WHERE o.id=$1 AND a.recovery_request_id=(o.payload_reference->>'recovery_request_id')::uuid`,
        [job.id]
      );
    }
    await client.query(
      `UPDATE ragic_z03_records
          SET claim_state=$2, last_error_code=NULL, last_processed_at=NOW()
        WHERE z01_ragic_record_id=$1`,
      [job.source_record_id, isRebind ? 'ACCOUNT_REBOUND' : 'SYNCED']
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function _markCreateSuccess(job, ragicRecordId) {
  const recordId = String(ragicRecordId || '').trim();
  if (!recordId) {
    const err = new Error('Ragic create success missing record id');
    err.code = 'RAGIC_UNCONFIRMED_WRITE';
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = (await client.query(
      `SELECT * FROM identity_claims WHERE id=$1 FOR UPDATE`, [job.claim_id]
    )).rows[0];
    if (!claim?.canonical_parent_id) throw new Error('claim canonical parent missing');
    await client.query(
      `UPDATE parents SET ragic_record_id=COALESCE(ragic_record_id,$2),updated_at=NOW()
        WHERE id=$1`, [claim.canonical_parent_id, recordId]
    );
    await client.query(
      `UPDATE identity_claims SET state='SYNCED',source_record_id=$2,last_error_code=NULL,
          version=version+1,updated_at=NOW() WHERE id=$1`,
      [claim.id, recordId]
    );
    await client.query(
      `INSERT INTO source_record_links
         (source_system,source_table,source_record_id,canonical_parent_id,
          canonical_student_id,claim_id,link_method)
       VALUES ('RAGIC','Z01',$1,$2,$3,$4,'NEW_REGISTRATION_OUTBOX')
       ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
         canonical_parent_id=EXCLUDED.canonical_parent_id,
         canonical_student_id=COALESCE(source_record_links.canonical_student_id,EXCLUDED.canonical_student_id),
         claim_id=EXCLUDED.claim_id,updated_at=NOW()`,
      [recordId, claim.canonical_parent_id, claim.canonical_student_id, claim.id]
    );
    await client.query(
      `UPDATE ragic_sync_outbox SET state='synced',source_record_id=$2,target_record_id=$2,
          last_error_code=NULL,sanitized_error=NULL,completed_at=NOW(),updated_at=NOW()
        WHERE id=$1`, [job.id, recordId]
    );
    await client.query(
      `UPDATE parent_identity_requests SET state='SYNCED',updated_at=NOW()
        WHERE claim_id=$1`, [claim.id]
    );
    await client.query(
      `INSERT INTO identity_claim_events
         (claim_id,from_state,to_state,reason_code,actor_type,correlation_id)
       VALUES ($1,'SYNC_PENDING','SYNCED','RAGIC_CREATE_CONFIRMED','outbox-worker',$2)`,
      [claim.id, claim.correlation_id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function _findRemoteByTrueUid(lineUid) {
  const uid = String(lineUid || '').trim();
  if (!uid) return null;
  const page = await ragic.fetchPage(process.env.RAGIC_FORM_Z01, {
    where: `${RAGIC_Z01_FIELDS.PARENT_SYSTEM_LINE_UID},eq,${uid}`,
    naming: 'EID',
    subtables: true,
    limit: 100,
    offset: 0,
  });
  const matches = (page.rows || []).filter((row) => getTrueRagicLineUid(row) === uid);
  if (matches.length > 1) {
    const err = new Error('Ragic field 1006846 contains duplicate LINE UID sources');
    err.code = 'RAGIC_UID_DUPLICATE';
    throw err;
  }
  return matches[0] || null;
}

function _recordIdOf(row) {
  return String(row?._ragicId || row?.ragicId || '').trim();
}

function _assertReadback({ row, targetRecordId, expectedPatch, expectedUid }) {
  if (!row || _recordIdOf(row) !== String(targetRecordId || '').trim()) {
    const err = new Error('Ragic readback record id mismatch');
    err.code = 'RAGIC_UNCONFIRMED_WRITE';
    throw err;
  }
  if (expectedUid && getTrueRagicLineUid(row) !== expectedUid) {
    const err = new Error('Ragic field 1006846 readback mismatch');
    err.code = 'RAGIC_UNCONFIRMED_WRITE';
    throw err;
  }
  for (const [fieldId, value] of Object.entries(expectedPatch || {})) {
    if (String(row[fieldId] == null ? '' : row[fieldId]).trim() !== String(value).trim()) {
      const err = new Error('Ragic allowlisted profile readback mismatch');
      err.code = 'RAGIC_UNCONFIRMED_WRITE';
      throw err;
    }
  }
}

function _httpStatusFromWriterResult(result) {
  return Number(result?.responseMetadata?.httpStatus || result?.http_status || 0) || null;
}

function _logSchemaGuardFailure(err) {
  console.error(JSON.stringify({
    event: 'ragic_parent_outbox_schema_guard_failed',
    code: err?.code || 'RAGIC_SCHEMA_NOT_VERIFIED',
    message: 'worker stopped before claiming a job; local parent login remains available',
    expected: err?.schema?.expected || null,
    actual: err?.schema?.actual || err?.evidence || null,
    differences: err?.schema?.differences || null,
    correlationId: err?.schema?.correlationId || err?.correlationId || null,
  }));
}

async function _loadCanonicalParent(job) {
  const claim = (await pool.query(
    `SELECT canonical_parent_id FROM identity_claims WHERE id=$1`, [job.claim_id]
  )).rows[0];
  const parent = claim?.canonical_parent_id
    ? (await pool.query(`SELECT * FROM parents WHERE id=$1`, [claim.canonical_parent_id])).rows[0]
    : null;
  if (!parent?.line_uid) {
    const err = new Error('canonical parent has no LINE UID');
    err.code = 'LINE_UID_REQUIRED';
    throw err;
  }
  return parent;
}

async function readbackRagicSyncOutboxJob({
  job,
  reader = ragic.getParentRecordByRagicId,
} = {}) {
  if (!job || job.operation !== 'BIND_Z01_LINE_UID') {
    const err = new Error('readback is restricted to BIND_Z01_LINE_UID jobs');
    err.code = 'RAGIC_OUTBOX_OPERATION_UNSUPPORTED';
    throw err;
  }
  const parent = await _loadCanonicalParent(job);
  const targetRecordId = job.target_record_id || job.source_record_id;
  const profilePatch = sanitizeAllowlistedProfilePatch(job.payload_reference?.profile_patch);
  const row = await reader(targetRecordId);
  _assertReadback({
    row,
    targetRecordId,
    expectedPatch: profilePatch,
    expectedUid: parent.line_uid,
  });
  return {
    job_id: job.id,
    correlation_id: job.correlation_id,
    node: String(targetRecordId),
    readback_verified: true,
    final_job_state: job.state,
  };
}

async function _markFailure(job, err) {
  const failure = classifySyncFailure(err, Number(job.attempts), Number(job.max_attempts));
  const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, Number(job.attempts) - 1)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE ragic_sync_outbox SET
         state=$2, last_error_code=$3, sanitized_error=$4,
         next_retry_at=CASE WHEN $2='retryable' THEN NOW()+($5::text||' seconds')::interval ELSE next_retry_at END,
         updated_at=NOW()
       WHERE id=$1`,
      [job.id, failure.outboxState, failure.code, _sanitizedError(err, failure.code), delaySeconds]
    );
    const isRebind = job.operation === 'REBIND_Z01_LINE_UID';
    const claimState = isRebind ? 'ACCOUNT_REBIND_SYNC_PENDING' : failure.claimState;
    const claim = (await client.query(
      `UPDATE identity_claims SET
         state=$2, last_error_code=$3, retry_count=retry_count+1,
         version=version+1, updated_at=NOW()
       WHERE id=$1 RETURNING id, correlation_id`,
      [job.claim_id, claimState, failure.code]
    )).rows[0];
    if (claim) {
      await client.query(
        `INSERT INTO identity_claim_events
           (claim_id,from_state,to_state,reason_code,actor_type,correlation_id)
         VALUES ($1,$2,$3,$4,'outbox-worker',$5)`,
        [claim.id, isRebind ? 'ACCOUNT_REBIND_SYNC_PENDING' : 'SYNC_PENDING',
         claimState, failure.code, claim.correlation_id]
      );
    }
    if (isRebind) {
      await client.query(
        `UPDATE parent_account_recovery_requests r
            SET ragic_sync_state='ACCOUNT_REBIND_SYNC_PENDING',last_error_code=$2,updated_at=NOW()
           FROM ragic_sync_outbox o
          WHERE o.id=$1 AND r.id=(o.payload_reference->>'recovery_request_id')::uuid`,
        [job.id, failure.code]
      );
      await client.query(
        `UPDATE parent_line_uid_rebind_audit a
            SET ragic_sync_state='ACCOUNT_REBIND_SYNC_PENDING'
           FROM ragic_sync_outbox o
          WHERE o.id=$1 AND a.recovery_request_id=(o.payload_reference->>'recovery_request_id')::uuid`,
        [job.id]
      );
    }
    await client.query(
      `UPDATE ragic_z03_records SET
         claim_state=$2, last_error_code=$3, last_processed_at=NOW()
       WHERE z01_ragic_record_id=$1`,
      [job.source_record_id, isRebind ? 'ACCOUNT_REBIND_SYNC_PENDING' : failure.claimState, failure.code]
    );
    if (job.operation === 'CREATE_Z01_PARENT') {
      await client.query(
        `UPDATE parent_identity_requests SET state=$2,updated_at=NOW() WHERE claim_id=$1`,
        [job.claim_id, failure.claimState]
      );
    }
    if (failure.outboxState !== 'retryable') {
      const parent = (await client.query(
        `SELECT p.* FROM identity_claims c JOIN parents p ON p.id=c.canonical_parent_id WHERE c.id=$1`,
        [job.claim_id]
      )).rows[0] || null;
      await createParentIdentityBackofficeTask({
        client,
        parent,
        sourceRecordIds: [job.target_record_id || job.source_record_id].filter(Boolean),
        reasonCode: failure.claimState,
        suggestedAction: failure.claimState === 'SYNC_BLOCKED_SCHEMA'
          ? 'Complete the required Ragic profile schema fields, then replay the same outbox job.'
          : 'Reconcile the source conflict without changing orders, payments, lessons, or attendance.',
        correlationId: job.correlation_id,
      });
    }
    await client.query('COMMIT');
    return failure;
  } catch (dbErr) {
    await client.query('ROLLBACK').catch(() => {});
    throw dbErr;
  } finally {
    client.release();
  }
}

async function processClaimedRagicSyncOutboxJob(job, {
  writer = ragic.upsertParentStrict,
  reader = ragic.getParentRecordByRagicId,
  studentWriter = ragic.updateStudentFromZ03Strict,
  forceReadback = false,
} = {}) {
  const metadata = {
    job_id: job.id,
    correlation_id: job.correlation_id,
    node: String(job.target_record_id || job.source_record_id || ''),
    before_state: job._claimed_from_state || 'processing',
    after_state: null,
    attempts_before: job._claimed_from_attempts == null
      ? Math.max(0, Number(job.attempts) - 1)
      : Number(job._claimed_from_attempts),
    attempts_after: Number(job.attempts),
    write_performed: false,
    http_status: null,
    readback_verified: false,
  };
  try {
    if (!['BIND_Z01_LINE_UID', 'REBIND_Z01_LINE_UID', 'CREATE_Z01_PARENT'].includes(job.operation)) {
      const err = new Error('unsupported outbox operation');
      err.code = 'RAGIC_OUTBOX_OPERATION_UNSUPPORTED';
      throw err;
    }
    const parent = await _loadCanonicalParent(job);
    if (job.operation === 'BIND_Z01_LINE_UID' || job.operation === 'REBIND_Z01_LINE_UID') {
      const targetRecordId = job.target_record_id || job.source_record_id;
      const ref = job.payload_reference || {};
      const profilePatch = sanitizeAllowlistedProfilePatch(ref.profile_patch);
      const patch = { ...profilePatch };
      if (!ref.skip_uid_write) patch[RAGIC_Z01_FIELDS.PARENT_SYSTEM_LINE_UID] = parent.line_uid;
      const shouldReadback = forceReadback || ref.verify_readback;
      if (shouldReadback) {
        const before = await reader(targetRecordId);
        if (!before || _recordIdOf(before) !== String(targetRecordId)) {
          const err = new Error('Ragic target record is missing or changed');
          err.code = 'RAGIC_UNCONFIRMED_WRITE';
          throw err;
        }
        const currentUid = getTrueRagicLineUid(before);
        if (currentUid && currentUid !== parent.line_uid) {
          const err = new Error('Ragic field 1006846 already belongs to another account');
          err.code = 'PARENT_LINE_UID_MISMATCH';
          throw err;
        }
      }
      for (const student of Array.isArray(ref.students_to_append) ? ref.students_to_append : []) {
        const studentResult = await studentWriter({
          parent: { ...parent, ragic_record_id: String(targetRecordId) },
          student,
        });
        metadata.write_performed = true;
        metadata.http_status = metadata.http_status || _httpStatusFromWriterResult(studentResult);
        const localStudent = (await pool.query(
          `SELECT id FROM students WHERE parent_id=$1 AND regexp_replace(lower(name),'\\s','','g')=regexp_replace(lower($2),'\\s','','g')
            ORDER BY created_at,id LIMIT 1`,
          [parent.id, String(student?.name || '').trim()]
        )).rows[0];
        const z02Id = studentResult?.z02?.ragicRecordId || null;
        if (localStudent && z02Id) {
          await pool.query(
            `UPDATE students SET ragic_record_id=COALESCE(ragic_record_id,$2),last_synced_at=NOW(),updated_at=NOW()
              WHERE id=$1`, [localStudent.id, String(z02Id)]
          );
        }
      }
      if (Object.keys(patch).length) {
        const writeResult = await writer(patch, targetRecordId, { includeResponseMetadata: true });
        metadata.write_performed = true;
        metadata.http_status = _httpStatusFromWriterResult(writeResult) || metadata.http_status;
      }
      if (shouldReadback) {
        const after = await reader(targetRecordId);
        _assertReadback({
          row: after,
          targetRecordId,
          expectedPatch: profilePatch,
          expectedUid: parent.line_uid,
        });
        metadata.readback_verified = true;
      }
      await _markSuccess(job);
    } else {
      // A create response may time out after Ragic committed. Always perform a
      // strict Field-ID lookup before retrying create; display-name payloads are
      // intentionally rejected by getTrueRagicLineUid().
      let remote = await _findRemoteByTrueUid(parent.line_uid);
      let recordId = remote?._ragicId || remote?.ragicId || null;
      if (!remote) {
        const ref = job.payload_reference || {};
        const created = await ragic.createParentWithStudentsInRagic({
          parent: { ...(ref.parent || {}), phone: parent.phone, name: parent.name },
          students: Array.isArray(ref.students) ? ref.students : [],
          lineUid: parent.line_uid,
        });
        metadata.write_performed = true;
        metadata.http_status = _httpStatusFromWriterResult(created);
        recordId = created.ragicRecordId;
      }
      await _markCreateSuccess(job, recordId);
    }
    metadata.after_state = 'synced';
    return { ...metadata, outcome: 'synced', final_job_state: 'synced' };
  } catch (err) {
    const failure = await _markFailure(job, err);
    metadata.after_state = failure.outboxState;
    return {
      ...metadata,
      outcome: failure.outboxState === 'retryable' ? 'retryable' : 'blocked',
      final_job_state: failure.outboxState,
      error_code: failure.code,
    };
  }
}

async function processRagicSyncOutboxJob({
  jobId,
  idempotencyKey,
  sourceRecordId,
  targetRecordId,
  operation,
  requiredState = 'pending',
  requiredAttempts = 0,
  writer = ragic.upsertParentStrict,
  reader = ragic.getParentRecordByRagicId,
  studentWriter = ragic.updateStudentFromZ03Strict,
  schemaGuard = assertRagicZ01UidSchemaFresh,
  forceReadback = true,
} = {}) {
  try {
    await schemaGuard();
  } catch (err) {
    if (SCHEMA_CODES.has(err.code)) {
      _logSchemaGuardFailure(err);
      return { status: 'SCHEMA_BLOCKED', final_job_state: requiredState, error_code: 'RAGIC_SCHEMA_NOT_VERIFIED' };
    }
    throw err;
  }
  const job = await _claimExactJob({
    jobId,
    idempotencyKey,
    sourceRecordId,
    targetRecordId,
    operation,
    requiredState,
    requiredAttempts,
  });
  if (!job) return { status: 'NOT_CLAIMED', final_job_state: null };
  const processed = await processClaimedRagicSyncOutboxJob(job, {
    writer,
    reader,
    studentWriter,
    forceReadback,
  });
  return { status: processed.outcome === 'synced' ? 'SYNCED' : 'FAILED', ...processed };
}

async function processRagicSyncOutbox({
  limit = 20,
  writer = ragic.upsertParentStrict,
  reader = ragic.getParentRecordByRagicId,
  studentWriter = ragic.updateStudentFromZ03Strict,
  idempotencyKey = null,
  schemaGuard = assertRagicZ01UidSchemaFresh,
} = {}) {
  const result = { processed: 0, synced: 0, retryable: 0, blocked: 0 };
  if (!STABILITY_FLAGS.RAGIC_PARENT_OUTBOX && !idempotencyKey) {
    return { ...result, skipped: true, reason: 'RAGIC_PARENT_OUTBOX_DISABLED' };
  }
  try {
    await schemaGuard();
  } catch (err) {
    if (SCHEMA_CODES.has(err.code)) {
      _logSchemaGuardFailure(err);
      return { ...result, skipped: true, blocked: 1, reason: 'RAGIC_SCHEMA_NOT_VERIFIED' };
    }
    throw err;
  }
  for (let i = 0; i < limit; i++) {
    const job = await _claimNextJob(idempotencyKey);
    if (!job) break;
    job._claimed_from_state = Number(job.attempts) === 1 ? 'pending' : 'retryable';
    job._claimed_from_attempts = Math.max(0, Number(job.attempts) - 1);
    result.processed++;
    const processed = await processClaimedRagicSyncOutboxJob(job, { writer, reader, studentWriter });
    if (processed.outcome === 'synced') {
      result.synced++;
    } else if (processed.outcome === 'retryable') result.retryable++;
    else result.blocked++;
  }
  return result;
}

module.exports = {
  processRagicSyncOutbox,
  processRagicSyncOutboxJob,
  processClaimedRagicSyncOutboxJob,
  readbackRagicSyncOutboxJob,
  classifySyncFailure,
  _findRemoteByTrueUid,
  _claimExactJob,
};
