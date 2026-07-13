'use strict';

const crypto = require('crypto');
const { pool } = require('../models/db');
const { getTrueRagicLineUid } = require('../config/ragicSchema');
const { normalizePhone, normalizeStudentName } = require('./identityNormalizer');

const RECOVERY_STATES = Object.freeze({
  REQUIRED: 'ACCOUNT_RECOVERY_REQUIRED',
  VERIFYING: 'ACCOUNT_RECOVERY_VERIFYING',
  VERIFIED: 'ACCOUNT_RECOVERY_VERIFIED',
  REBIND_PENDING: 'ACCOUNT_REBIND_PENDING',
  REBOUND: 'ACCOUNT_REBOUND',
  FAILED: 'ACCOUNT_RECOVERY_FAILED',
  LOCKED: 'ACCOUNT_RECOVERY_LOCKED',
});

class AccountRecoveryError extends Error {
  constructor(code, message, http = 409, details = {}) {
    super(message);
    this.name = 'AccountRecoveryError';
    this.code = code;
    this.http = http;
    Object.assign(this, details);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function recoveryTokenMatches(request, token) {
  if (!request || !token) return false;
  return crypto.timingSafeEqual(
    Buffer.from(sha256(token)), Buffer.from(String(request.recovery_token_hash))
  );
}

function recoveryTtlMs() {
  const configured = Number(process.env.PARENT_ACCOUNT_RECOVERY_TTL_MS);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : 15 * 60 * 1000;
}

function recoveryRateLimit() {
  const configured = Number(process.env.PARENT_ACCOUNT_RECOVERY_RATE_LIMIT_MAX);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 5;
}

function recoveryRateWindowMs() {
  const configured = Number(process.env.PARENT_ACCOUNT_RECOVERY_RATE_WINDOW_MS);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : 60 * 60 * 1000;
}

function safeRecoveryResult(row, token = null, replayed = false) {
  return {
    recovery_request_id: row.id,
    state: row.state,
    recovery_token: token,
    expires_at: row.expires_at,
    correlation_id: row.correlation_id,
    replayed,
  };
}

async function insertEvent(client, requestId, fromState, toState, reasonCode, actor, correlationId) {
  await client.query(
    `INSERT INTO parent_account_recovery_events
       (recovery_request_id,from_state,to_state,reason_code,actor,correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [requestId, fromState, toState, reasonCode || null, actor, correlationId]
  );
}

async function resolveExactStudent(client, parentId, studentNameNormalized, requestedStudentId = null) {
  const rows = (await client.query(
    `SELECT * FROM students WHERE parent_id=$1 AND is_active=TRUE ORDER BY id FOR UPDATE`,
    [parentId]
  )).rows.filter((row) => normalizeStudentName(row.name) === studentNameNormalized);
  if (requestedStudentId) {
    const requested = rows.filter((row) => String(row.id) === String(requestedStudentId));
    if (requested.length === 1 && rows.length === 1) return requested[0];
  }
  if (rows.length !== 1) {
    throw new AccountRecoveryError(
      rows.length ? 'ACCOUNT_RECOVERY_FAILED' : 'IDENTITY_NOT_FOUND',
      'Account recovery requires one exact canonical student match'
    );
  }
  return rows[0];
}

async function assertSourceOwnership(client, { parent, student, ragicRecordId, expectedRagicUidHash = null }) {
  const sourceId = String(ragicRecordId || '');
  const shadow = (await client.query(
    `SELECT raw_data FROM ragic_z01_shadow WHERE ragic_record_id=$1 FOR UPDATE`, [sourceId]
  )).rows[0];
  const ragicOldUid = getTrueRagicLineUid(shadow?.raw_data);
  if (!ragicOldUid) {
    throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Ragic source does not contain a non-empty field 1006846');
  }
  if (expectedRagicUidHash && sha256(ragicOldUid) !== expectedRagicUidHash) {
    throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Ragic source UID changed during recovery');
  }
  const link = (await client.query(
    `SELECT canonical_parent_id,canonical_student_id FROM source_record_links
      WHERE source_system='RAGIC' AND source_table='Z01' AND source_record_id=$1 FOR UPDATE`,
    [sourceId]
  )).rows[0] || null;
  const parentOwnsSource = String(parent.ragic_record_id || '') === sourceId
    || String(link?.canonical_parent_id || '') === String(parent.id);
  if (!parentOwnsSource) {
    throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Ragic source is not linked to the canonical parent');
  }
  if (link?.canonical_student_id && String(link.canonical_student_id) !== String(student.id)) {
    throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Ragic source is linked to another canonical student');
  }
  return ragicOldUid;
}

async function requestAccountRecovery({
  phone,
  studentName,
  newLineUid,
  canonicalParentId = null,
  canonicalStudentId = null,
  ragicRecordId,
  claimId = null,
  initiatedBy = 'parent-auth',
  correlationId = crypto.randomUUID(),
  now = new Date(),
} = {}) {
  const phoneCanonical = normalizePhone(phone);
  const studentNameNormalized = normalizeStudentName(studentName);
  const requestedUid = String(newLineUid || '').trim();
  const sourceId = String(ragicRecordId || '').trim();
  if (!phoneCanonical || !studentNameNormalized || !requestedUid || !sourceId) {
    throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Recovery request identity evidence is incomplete', 400);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`account-recovery-phone:${phoneCanonical}`]);
    const candidates = (await client.query(
      `SELECT * FROM parents
        WHERE is_active=TRUE AND (phone=$1 OR regexp_replace(COALESCE(phone,''),'\D','','g')=$1)
        ORDER BY id FOR UPDATE`, [phoneCanonical]
    )).rows;
    const parentMatches = canonicalParentId
      ? candidates.filter((row) => String(row.id) === String(canonicalParentId))
      : candidates;
    if (candidates.length !== 1 || parentMatches.length !== 1) {
      throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Recovery requires one canonical parent');
    }
    const parent = parentMatches[0];
    if (!parent.line_uid || parent.line_uid === requestedUid) {
      throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Recovery requires a different existing LINE UID');
    }
    const student = await resolveExactStudent(client, parent.id, studentNameNormalized, canonicalStudentId);
    const ragicOldUid = await assertSourceOwnership(client, { parent, student, ragicRecordId: sourceId });
    const oldUidHash = sha256(parent.line_uid);
    const ragicOldUidHash = sha256(ragicOldUid);
    const newUidHash = sha256(requestedUid);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`line-uid:${newUidHash}`]);
    const otherUid = (await client.query(
      `SELECT id FROM parents WHERE is_active=TRUE AND line_uid=$1 AND id<>$2 FOR UPDATE`,
      [requestedUid, parent.id]
    )).rows[0];
    if (otherUid) throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'New LINE UID belongs to another active parent', 409);

    const requestKey = sha256([parent.id, student.id, sourceId, newUidHash].join(':'));
    let existing = (await client.query(
      `SELECT * FROM parent_account_recovery_requests WHERE request_key=$1 FOR UPDATE`, [requestKey]
    )).rows[0] || null;
    if (existing) {
      await client.query('COMMIT');
      return safeRecoveryResult(existing, null, true);
    }
    const active = (await client.query(
      `SELECT * FROM parent_account_recovery_requests
        WHERE canonical_parent_id=$1 AND state IN
          ('ACCOUNT_RECOVERY_REQUIRED','ACCOUNT_RECOVERY_VERIFYING','ACCOUNT_RECOVERY_VERIFIED','ACCOUNT_REBIND_PENDING')
        FOR UPDATE`, [parent.id]
    )).rows[0] || null;
    if (active && new Date(active.expires_at).getTime() <= now.getTime()) {
      await client.query(
        `UPDATE parent_account_recovery_requests
            SET state='ACCOUNT_RECOVERY_LOCKED',locked_at=$2,last_error_code='RECOVERY_TOKEN_EXPIRED',updated_at=$2
          WHERE id=$1`, [active.id, now]
      );
      await insertEvent(client, active.id, active.state, RECOVERY_STATES.LOCKED, 'RECOVERY_TOKEN_EXPIRED', initiatedBy, active.correlation_id);
      existing = null;
    } else if (active) {
      throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'Another new LINE UID is already recovering this parent');
    }

    const recentRequests = Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM parent_account_recovery_requests
        WHERE phone_canonical=$1 AND requested_at >= $2`,
      [phoneCanonical, new Date(now.getTime() - recoveryRateWindowMs())]
    )).rows[0].n);
    if (recentRequests >= recoveryRateLimit()) {
      throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'Account recovery rate limit exceeded', 429);
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + recoveryTtlMs());
    const row = (await client.query(
      `INSERT INTO parent_account_recovery_requests
         (request_key,state,canonical_parent_id,canonical_student_id,claim_id,ragic_record_id,
          phone_canonical,student_name_normalized,old_uid_hash,ragic_old_uid_hash,new_uid_hash,
          requested_line_uid,recovery_token_hash,initiated_by,correlation_id,requested_at,expires_at)
       VALUES ($1,'ACCOUNT_RECOVERY_REQUIRED',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [requestKey, parent.id, student.id, claimId, sourceId, phoneCanonical, studentNameNormalized,
       oldUidHash, ragicOldUidHash, newUidHash, requestedUid, sha256(token), initiatedBy,
       correlationId, now, expiresAt]
    )).rows[0];
    await insertEvent(client, row.id, null, RECOVERY_STATES.REQUIRED, 'PHONE_STUDENT_EXACT_UID_CONFLICT', initiatedBy, correlationId);
    await client.query('COMMIT');
    return safeRecoveryResult(row, token, false);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof AccountRecoveryError) throw err;
    if (err.code === '23505' && err.constraint === 'uq_parent_recovery_active_parent') {
      throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'Concurrent recovery already owns this parent');
    }
    throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Recovery request transaction failed', 500, {
      causeCode: err.code || null,
    });
  } finally {
    client.release();
  }
}

async function completeManualAccountRecovery({
  recoveryRequestId,
  recoveryToken,
  approvedBy,
  reason,
  evidenceReference,
  now = new Date(),
} = {}) {
  const reviewer = String(approvedBy || '').trim();
  const reviewReason = String(reason || '').trim();
  const evidence = String(evidenceReference || '').trim();
  if (!reviewer || !reviewReason || !evidence) {
    throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Reviewer, reason, and evidence reference are required', 400);
  }
  const client = await pool.connect();
  let pendingError = null;
  let currentRequest = null;
  try {
    await client.query('BEGIN');
    const request = (await client.query(
      `SELECT * FROM parent_account_recovery_requests WHERE id=$1 FOR UPDATE`, [recoveryRequestId]
    )).rows[0];
    if (!request) throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Recovery request not found', 404);
    currentRequest = request;
    if (request.state === RECOVERY_STATES.REBOUND) {
      if (!recoveryTokenMatches(request, recoveryToken)) {
        throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'Recovery replay token is invalid', 409);
      }
      const parent = (await client.query(`SELECT * FROM parents WHERE id=$1`, [request.canonical_parent_id])).rows[0];
      await client.query('COMMIT');
      return { parent, state: request.state, replayed: true, correlation_id: request.correlation_id };
    }

    const attempts = Number(request.attempts) + 1;
    const tokenValid = recoveryTokenMatches(request, recoveryToken);
    const expired = new Date(request.expires_at).getTime() <= now.getTime();
    if (!tokenValid || expired || attempts > Number(request.max_attempts)) {
      const locked = expired || attempts >= Number(request.max_attempts);
      const nextState = locked ? RECOVERY_STATES.LOCKED : RECOVERY_STATES.REQUIRED;
      const code = expired ? 'RECOVERY_TOKEN_EXPIRED' : (locked ? 'RECOVERY_ATTEMPTS_EXCEEDED' : 'RECOVERY_TOKEN_INVALID');
      await client.query(
        `UPDATE parent_account_recovery_requests SET attempts=$2,state=$3,last_error_code=$4,
           locked_at=CASE WHEN $3='ACCOUNT_RECOVERY_LOCKED' THEN $5 ELSE locked_at END,updated_at=$5
         WHERE id=$1`, [request.id, attempts, nextState, code, now]
      );
      if (nextState !== request.state) {
        await insertEvent(client, request.id, request.state, nextState, code, reviewer, request.correlation_id);
      }
      await client.query('COMMIT');
      pendingError = new AccountRecoveryError(nextState, 'Recovery token is invalid, expired, or locked', 409);
    } else {
      await client.query(
        `UPDATE parent_account_recovery_requests SET state='ACCOUNT_RECOVERY_VERIFYING',attempts=$2,
           verifying_at=$3,approved_by=$4,verification_method='MANUAL_VERIFIED',
           verification_reference=$5,reason=$6,updated_at=$3 WHERE id=$1`,
        [request.id, attempts, now, reviewer, evidence, reviewReason]
      );
      await insertEvent(client, request.id, request.state, RECOVERY_STATES.VERIFYING, 'MANUAL_REVIEW_STARTED', reviewer, request.correlation_id);

      const parent = (await client.query(
        `SELECT * FROM parents WHERE id=$1 AND is_active=TRUE FOR UPDATE`, [request.canonical_parent_id]
      )).rows[0];
      if (!parent || normalizePhone(parent.phone) !== request.phone_canonical || sha256(parent.line_uid) !== request.old_uid_hash) {
        throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Canonical parent identity changed before rebind');
      }
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`line-uid:${request.old_uid_hash}`]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`line-uid:${request.new_uid_hash}`]);
      const student = await resolveExactStudent(
        client, parent.id, request.student_name_normalized, request.canonical_student_id
      );
      await assertSourceOwnership(client, {
        parent,
        student,
        ragicRecordId: request.ragic_record_id,
        expectedRagicUidHash: request.ragic_old_uid_hash,
      });
      const otherParent = (await client.query(
        `SELECT id FROM parents WHERE is_active=TRUE AND line_uid=$1 AND id<>$2 FOR UPDATE`,
        [request.requested_line_uid, parent.id]
      )).rows[0];
      if (otherParent) throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'New LINE UID became active on another parent');

      await client.query(
        `UPDATE parent_account_recovery_requests SET state='ACCOUNT_RECOVERY_VERIFIED',verified_at=$2,updated_at=$2 WHERE id=$1`,
        [request.id, now]
      );
      await insertEvent(client, request.id, RECOVERY_STATES.VERIFYING, RECOVERY_STATES.VERIFIED, 'MANUAL_EVIDENCE_VERIFIED', reviewer, request.correlation_id);
      await client.query(
        `UPDATE parent_account_recovery_requests SET state='ACCOUNT_REBIND_PENDING',updated_at=$2 WHERE id=$1`,
        [request.id, now]
      );
      await insertEvent(client, request.id, RECOVERY_STATES.VERIFIED, RECOVERY_STATES.REBIND_PENDING, 'ATOMIC_REBIND_STARTED', reviewer, request.correlation_id);

      await client.query(
        `INSERT INTO parent_line_uid_bindings
           (canonical_parent_id,uid_hash,status,activated_at,correlation_id)
         VALUES ($1,$2,'ACTIVE',COALESCE($3::timestamptz,$4::timestamptz),$5)
         ON CONFLICT DO NOTHING`,
        [parent.id, request.old_uid_hash, parent.created_at, now, request.correlation_id]
      );
      await client.query(
        `UPDATE parent_line_uid_bindings SET status='REPLACED',revoked_at=$2,
           replaced_by_uid_hash=$3,updated_at=$2
         WHERE canonical_parent_id=$1 AND status='ACTIVE'`,
        [parent.id, now, request.new_uid_hash]
      );
      await client.query(
        `INSERT INTO parent_line_uid_bindings
           (canonical_parent_id,uid_hash,status,activated_at,correlation_id)
         VALUES ($1,$2,'ACTIVE',$3,$4)`,
        [parent.id, request.new_uid_hash, now, request.correlation_id]
      );
      const reboundParent = (await client.query(
        `UPDATE parents SET line_uid=$2,updated_at=$3 WHERE id=$1 AND line_uid=$4 RETURNING *`,
        [parent.id, request.requested_line_uid, now, parent.line_uid]
      )).rows[0];
      if (!reboundParent) throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Atomic parent rebind compare-and-set failed');

      let claimId = request.claim_id;
      if (!claimId) {
        claimId = (await client.query(
          `INSERT INTO identity_claims
             (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
              canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
              correlation_id,verified_at,linked_at)
           VALUES ('ACCOUNT_RECOVERY','ACCOUNT_REBIND_SYNC_PENDING',$1,$2,$3,$4,$5,
                   'RAGIC','Z01',$6,$7,$8,$8)
           ON CONFLICT (purpose,source_system,source_table,source_record_id,student_name_normalized)
           DO UPDATE SET state='ACCOUNT_REBIND_SYNC_PENDING',canonical_parent_id=EXCLUDED.canonical_parent_id,
             canonical_student_id=EXCLUDED.canonical_student_id,line_uid_hash=EXCLUDED.line_uid_hash,
             last_error_code=NULL,version=identity_claims.version+1,updated_at=$8
           RETURNING id`,
          [request.phone_canonical, request.student_name_normalized, parent.id, student.id,
           request.new_uid_hash, request.ragic_record_id, request.correlation_id, now]
        )).rows[0].id;
      } else {
        await client.query(
          `UPDATE identity_claims SET state='ACCOUNT_REBIND_SYNC_PENDING',line_uid_hash=$2,
             canonical_parent_id=$3,canonical_student_id=$4,last_error_code=NULL,
             version=version+1,updated_at=$5 WHERE id=$1`,
          [claimId, request.new_uid_hash, parent.id, student.id, now]
        );
      }
      await client.query(
        `INSERT INTO parent_line_uid_rebind_audit
           (canonical_parent_id,ragic_record_id,recovery_request_id,old_uid_hash,new_uid_hash,
            verification_method,verification_reference,initiated_by,approved_by,reason,reason_code,
            correlation_id,requested_at,verified_at,committed_at,ragic_sync_state)
         VALUES ($1,$2,$3,$4,$5,'MANUAL_VERIFIED',$6,$7,$8,$9,'ACCOUNT_RECOVERY_VERIFIED',
                 $10,$11,$12,$12,'ACCOUNT_REBIND_SYNC_PENDING')`,
        [parent.id, request.ragic_record_id, request.id, request.old_uid_hash, request.new_uid_hash,
         evidence, request.initiated_by, reviewer, reviewReason, request.correlation_id,
         request.requested_at, now]
      );
      await client.query(
        `INSERT INTO ragic_sync_outbox
           (idempotency_key,claim_id,operation,source_system,source_table,source_record_id,
            target_record_id,field_id,payload_reference,state,correlation_id)
         VALUES ($1,$2,'REBIND_Z01_LINE_UID','RAGIC','Z01',$3,$3,'1006846',$4::jsonb,'pending',$5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [`rebind-z01-line-uid:${request.id}`, claimId, request.ragic_record_id,
         JSON.stringify({ recovery_request_id: request.id, canonical_parent_id: parent.id }), request.correlation_id]
      );
      await client.query(
        `UPDATE ragic_z03_records SET canonical_parent_id=$2,canonical_student_id=$3,
           claim_state='ACCOUNT_REBIND_SYNC_PENDING',reason_code='ACCOUNT_REBOUND_LOCAL',
           last_error_code=NULL,last_processed_at=$4,correlation_id=$5
         WHERE z01_ragic_record_id=$1`,
        [request.ragic_record_id, parent.id, student.id, now, request.correlation_id]
      );
      await client.query(
        `UPDATE parent_account_recovery_requests SET state='ACCOUNT_REBOUND',claim_id=$2,
           consumed_at=$3,committed_at=$3,ragic_sync_state='ACCOUNT_REBIND_SYNC_PENDING',
           last_error_code=NULL,updated_at=$3 WHERE id=$1`,
        [request.id, claimId, now]
      );
      await insertEvent(client, request.id, RECOVERY_STATES.REBIND_PENDING, RECOVERY_STATES.REBOUND, 'LOCAL_REBIND_COMMITTED', reviewer, request.correlation_id);
      await client.query('COMMIT');
      return {
        parent: reboundParent,
        state: RECOVERY_STATES.REBOUND,
        sync_state: 'ACCOUNT_REBIND_SYNC_PENDING',
        replayed: false,
        correlation_id: request.correlation_id,
      };
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // The identity mutation remains fully rolled back. Persist only the terminal
    // request/audit state in a separate transaction so operators can prove why
    // the old UID stayed active and safely decide whether a new verification is
    // appropriate. This transaction never touches parents, students or outbox.
    if (currentRequest && currentRequest.state !== RECOVERY_STATES.REBOUND) {
      try {
        const failureState = err.code === RECOVERY_STATES.LOCKED
          ? RECOVERY_STATES.LOCKED : RECOVERY_STATES.FAILED;
        await client.query('BEGIN');
        const persisted = (await client.query(
          `SELECT state,correlation_id FROM parent_account_recovery_requests WHERE id=$1 FOR UPDATE`,
          [currentRequest.id]
        )).rows[0];
        if (persisted && persisted.state !== RECOVERY_STATES.REBOUND) {
          await client.query(
            `UPDATE parent_account_recovery_requests
                SET state=$2,attempts=LEAST(attempts+1,max_attempts),last_error_code=$3,
                    failed_at=CASE WHEN $2='ACCOUNT_RECOVERY_FAILED' THEN NOW() ELSE failed_at END,
                    locked_at=CASE WHEN $2='ACCOUNT_RECOVERY_LOCKED' THEN NOW() ELSE locked_at END,
                    updated_at=NOW()
              WHERE id=$1`,
            [currentRequest.id, failureState, err.code || 'ACCOUNT_RECOVERY_FAILED']
          );
          await insertEvent(
            client, currentRequest.id, persisted.state, failureState,
            err.code || 'ACCOUNT_RECOVERY_FAILED', reviewer, persisted.correlation_id
          );
        }
        await client.query('COMMIT');
      } catch (_) {
        await client.query('ROLLBACK').catch(() => {});
      }
    }
    if (err instanceof AccountRecoveryError) throw err;
    throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Atomic account rebind transaction failed', 500, {
      causeCode: err.code || null,
      constraint: err.constraint || null,
      causeMessage: err.message || null,
    });
  } finally {
    client.release();
  }
  if (pendingError) throw pendingError;
  throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Recovery did not reach a terminal result', 500);
}

module.exports = {
  RECOVERY_STATES,
  AccountRecoveryError,
  requestAccountRecovery,
  completeManualAccountRecovery,
  __test__: { sha256, recoveryTtlMs, recoveryRateLimit, recoveryRateWindowMs },
};
