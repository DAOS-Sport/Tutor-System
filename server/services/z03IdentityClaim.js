'use strict';

const crypto = require('crypto');
const { pool } = require('../models/db');
const { normalizePhone, normalizeStudentName } = require('./identityNormalizer');
const { resolveMultipleSourceCandidate } = require('./parentIdentityResolver');
const { evaluateParentIdentityCanary } = require('./parentIdentityCanary');

class Z03ClaimError extends Error {
  constructor(code, message, http = 409, details = {}) {
    super(message);
    this.name = 'Z03ClaimError';
    this.code = code;
    this.http = http;
    Object.assign(this, details);
  }
}

function _lineUidHash(lineUid) {
  return crypto.createHash('sha256').update(String(lineUid || '')).digest('hex');
}

function _safeDate(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!m) return null;
  const normalized = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return Number.isNaN(new Date(`${normalized}T00:00:00+08:00`).getTime()) ? null : normalized;
}

function _payloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function _classifyConstraint(err) {
  if (err?.code !== '23505') return 'LOCAL_LINK_FAILED';
  const byConstraint = {
    parents_phone_key: 'DATA_RECONCILIATION_PENDING',
    parents_line_uid_key: 'ACCOUNT_RECOVERY_REQUIRED',
    uq_parents_ragic_record_id: 'DATA_RECONCILIATION_PENDING',
    uq_students_ragic_record_id: 'DATA_RECONCILIATION_PENDING',
    uq_identity_claims_active_source: 'DATA_RECONCILIATION_PENDING',
  };
  return byConstraint[err.constraint] || 'LOCAL_LINK_FAILED';
}

async function registerNewParentLocalFirst({
  parent: parentInput,
  students = [],
  lineUid,
  idempotencyKey,
  correlationId = crypto.randomUUID(),
} = {}) {
  const phoneCanonical = normalizePhone(parentInput?.phone);
  const uid = String(lineUid || '').trim();
  const cleanStudents = students.filter((s) => normalizeStudentName(s?.name));
  if (!phoneCanonical || !uid || !cleanStudents.length) {
    throw new Z03ClaimError('LOCAL_LINK_FAILED', '建立本地身分所需資料不足', 400);
  }
  const requestKey = String(idempotencyKey || _payloadHash({ uid, phoneCanonical, names: cleanStudents.map((s) => normalizeStudentName(s.name)) }));
  const lineUidHash = _lineUidHash(uid);
  const payload = { parent: { ...parentInput, phone: phoneCanonical }, students: cleanStudents };
  const payloadHash = _payloadHash(payload);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`canonical-parent:${phoneCanonical}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`line-uid:${lineUidHash}`]);
    const replay = (await client.query(
      `SELECT r.*,p.* FROM parent_identity_requests r
        LEFT JOIN parents p ON p.id=r.canonical_parent_id
       WHERE r.line_uid_hash=$1 AND r.operation='NEW_REGISTRATION' AND r.idempotency_key=$2
       FOR UPDATE OF r`, [lineUidHash, requestKey]
    )).rows[0] || null;
    if (replay) {
      if (replay.payload_hash !== payloadHash) {
        throw new Z03ClaimError('LOCAL_LINK_FAILED', '相同 idempotency key 的 payload 不一致', 409);
      }
      await client.query('COMMIT');
      return { parent: replay, replayed: true, sync_state: replay.state, correlation_id: replay.correlation_id };
    }

    const byUid = (await client.query(`SELECT * FROM parents WHERE line_uid=$1 FOR UPDATE`, [uid])).rows[0] || null;
    const phoneRows = (await client.query(
      `SELECT * FROM parents WHERE phone=$1 OR regexp_replace(COALESCE(phone,''),'\\D','','g')=$1 FOR UPDATE`,
      [phoneCanonical]
    )).rows;
    if (phoneRows.length > 1) throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', '手機命中多個 canonical parent');
    let parent = phoneRows[0] || byUid || null;
    if (byUid && parent && byUid.id !== parent.id) throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', 'LINE UID 與手機指向不同 parent');
    if (parent?.line_uid && parent.line_uid !== uid) throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', '手機已綁定另一個 LINE UID');
    if (!parent) {
      parent = (await client.query(
        `INSERT INTO parents
           (phone,name,line_uid,primary_venue_id,gender,email,identity,home_phone,home_address,line_id,is_active)
         VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),TRUE)
         RETURNING *`,
        [phoneCanonical, String(parentInput.name || '').trim() || '未命名家長', uid,
         parentInput.primary_venue_id || null, parentInput.gender || '', parentInput.email || '',
         parentInput.identity || '', parentInput.home_phone || '', parentInput.home_address || '', parentInput.line_id || '']
      )).rows[0];
    }

    const localStudents = (await client.query(`SELECT * FROM students WHERE parent_id=$1 FOR UPDATE`, [parent.id])).rows;
    const linkedStudents = [];
    for (const sourceStudent of cleanStudents) {
      const normalized = normalizeStudentName(sourceStudent.name);
      const matches = localStudents.filter((row) => normalizeStudentName(row.name) === normalized);
      if (matches.length > 1) throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', '同名學員命中多筆');
      let student = matches[0] || null;
      if (!student) {
        student = (await client.query(
          `INSERT INTO students
             (parent_id,name,birth_date,gender,id_number,blood_type,student_code,is_active)
           VALUES ($1,$2,$3::date,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),TRUE)
           RETURNING *`,
          [parent.id, sourceStudent.name, _safeDate(sourceStudent.birth_date), sourceStudent.gender || '',
           sourceStudent.id_number || '', sourceStudent.blood_type || '', sourceStudent.student_code || '']
        )).rows[0];
        localStudents.push(student);
      }
      linkedStudents.push(student);
    }

    const pendingSourceId = `PENDING:${requestKey}`;
    const claim = (await client.query(
      `INSERT INTO identity_claims
         (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
          canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
          correlation_id,verified_at,linked_at)
       VALUES ('NEW_REGISTRATION','SYNC_PENDING',$1,$2,$3,$4,$5,'RAGIC','Z01',$6,$7,NOW(),NOW())
       RETURNING *`,
      [phoneCanonical, normalizeStudentName(cleanStudents[0].name), parent.id, linkedStudents[0].id,
       lineUidHash, pendingSourceId, correlationId]
    )).rows[0];
    await client.query(
      `INSERT INTO ragic_sync_outbox
         (idempotency_key,claim_id,operation,source_system,source_table,source_record_id,
          payload_reference,state,correlation_id,field_id)
       VALUES ($1,$2,'CREATE_Z01_PARENT','RAGIC','Z01',$3,$4::jsonb,'pending',$5,'1006846')`,
      [`create-z01-parent:${requestKey}`, claim.id, pendingSourceId, JSON.stringify(payload), correlationId]
    );
    await client.query(
      `INSERT INTO parent_identity_requests
         (idempotency_key,line_uid_hash,operation,payload_hash,canonical_parent_id,
          canonical_student_id,claim_id,state,correlation_id)
       VALUES ($1,$2,'NEW_REGISTRATION',$3,$4,$5,$6,'SYNC_PENDING',$7)`,
      [requestKey, lineUidHash, payloadHash, parent.id, linkedStudents[0].id, claim.id, correlationId]
    );
    await client.query('COMMIT');
    return { parent, students: linkedStudents, replayed: false, sync_state: 'SYNC_PENDING', correlation_id: correlationId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof Z03ClaimError) throw err;
    throw new Z03ClaimError(_classifyConstraint(err), '本地新會員 transaction 失敗', 409, {
      constraint: err.constraint || null,
    });
  } finally {
    client.release();
  }
}

async function _persistManualReview({ z03Ids = [], sourceRecordId = null, phoneCanonical, studentNameNormalized, lineUid, code, correlationId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (z03Ids.length) {
      await client.query(
        `UPDATE ragic_z03_records
            SET status = 'manual_review', classification = 'MANUAL_REVIEW',
                claim_state = 'MANUAL_REVIEW', reason_code = $2,
                last_error_code = $2, last_processed_at = NOW(),
                correlation_id = COALESCE(correlation_id, $3::uuid)
          WHERE id = ANY($1::bigint[])`,
        [z03Ids, code, correlationId]
      );
    }
    if (sourceRecordId) {
      const claim = (await client.query(
        `INSERT INTO identity_claims
           (purpose, state, phone_canonical, student_name_normalized, line_uid_hash,
            source_system, source_table, source_record_id, last_error_code, correlation_id)
         VALUES ('CLAIM_LEGACY','MANUAL_REVIEW',$1,$2,$3,'RAGIC','Z01',$4,$5,$6)
         ON CONFLICT (purpose, source_system, source_table, source_record_id, student_name_normalized)
         DO UPDATE SET state='MANUAL_REVIEW', last_error_code=EXCLUDED.last_error_code,
                       retry_count=identity_claims.retry_count+1,
                       version=identity_claims.version+1, updated_at=NOW()
         RETURNING id, correlation_id`,
        [phoneCanonical, studentNameNormalized, _lineUidHash(lineUid), sourceRecordId, code, correlationId]
      )).rows[0];
      await client.query(
        `INSERT INTO identity_claim_events
           (claim_id, from_state, to_state, reason_code, actor_type, correlation_id)
         VALUES ($1,NULL,'MANUAL_REVIEW',$2,'parent',$3)`,
        [claim.id, code, claim.correlation_id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function claimZ03Identity({
  phone,
  studentName,
  lineUid,
  parentName = '',
  z03Id = null,
  sourceRecordId = null,
  actor = 'parent-auth',
  correlationId = crypto.randomUUID(),
} = {}) {
  const phoneCanonical = normalizePhone(phone);
  const studentNameNormalized = normalizeStudentName(studentName);
  if (!phoneCanonical) throw new Z03ClaimError('INVALID_PHONE', '手機無法正規化', 400);
  if (!studentNameNormalized) throw new Z03ClaimError('STUDENT_NAME_REQUIRED', '學員姓名必填', 400);
  if (!String(lineUid || '').trim()) throw new Z03ClaimError('LINE_UID_REQUIRED', 'LINE UID 必填', 400);

  const client = await pool.connect();
  let reviewContext = null;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`canonical-parent:${phoneCanonical}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`line-uid:${_lineUidHash(lineUid)}`]);

    const params = [];
    const where = [];
    if (z03Id) {
      params.push(z03Id);
      where.push(`id = $${params.length}`);
    } else if (sourceRecordId) {
      params.push(String(sourceRecordId));
      where.push(`z01_ragic_record_id = $${params.length}`);
    } else {
      params.push(phoneCanonical);
      where.push(`(phone_canonical = $${params.length}
        OR regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $${params.length})`);
    }
    const families = (await client.query(
      `SELECT * FROM ragic_z03_records
        WHERE ${where.join(' AND ')}
          AND status IN ('pending','resolved','manual_review')
        ORDER BY fetched_at DESC, id
        FOR UPDATE`,
      params
    )).rows;
    if (!families.length) {
      throw new Z03ClaimError('IDENTITY_NOT_FOUND', '找不到同一家庭的 Z03 source record', 404);
    }

    const familyIds = families.map((row) => row.id);
    const childRows = (await client.query(
      `SELECT * FROM ragic_z03_students
        WHERE z03_record_id = ANY($1::bigint[])
        ORDER BY z03_record_id, seq_raw, id
        FOR UPDATE`,
      [familyIds]
    )).rows;
    let exactMatches = childRows.filter((row) => normalizeStudentName(row.name_raw) === studentNameNormalized);
    if (exactMatches.length === 0) {
      reviewContext = {
        z03Ids: familyIds,
        sourceRecordId: families.length === 1 ? families[0].z01_ragic_record_id : null,
        code: 'IDENTITY_NOT_FOUND',
      };
      throw new Z03ClaimError('MANUAL_REVIEW_REQUIRED', '家庭內沒有 exact normalized student match', 409, {
        reason: 'IDENTITY_NOT_FOUND',
      });
    }
    const matchedFamilyIds = [...new Set(exactMatches.map((row) => row.z03_record_id))];
    const allExactMatchIds = exactMatches.map((row) => row.id);
    const matchedFamilies = families.filter((row) => matchedFamilyIds.includes(row.id));
    let aliasFamilies = [];
    let resolutionMethod = 'PHONE_AND_EXACT_STUDENT_NAME';
    if (exactMatches.length > 1 && matchedFamilyIds.length === 1) {
      reviewContext = {
        z03Ids: matchedFamilyIds,
        sourceRecordId: matchedFamilies[0]?.z01_ragic_record_id || null,
        code: 'AMBIGUOUS_STUDENT_MATCH',
      };
      throw new Z03ClaimError('AMBIGUOUS_STUDENT_MATCH', '同一 source 內學員姓名命中多列', 409, {
        reason: 'DATA_RECONCILIATION_PENDING',
      });
    }
    if (matchedFamilyIds.length > 1) {
      // Evidence-only winner order. No ID ordering, timestamps or first-row
      // fallback may choose the primary source.
      const localCandidates = (await client.query(
        `SELECT * FROM parents
          WHERE line_uid=$1 OR phone=$2 OR regexp_replace(COALESCE(phone,''),'\\D','','g')=$2
          ORDER BY id FOR UPDATE`, [lineUid, phoneCanonical]
      )).rows;
      const canonicalIds = [...new Set(localCandidates.map((row) => String(row.id)))];
      if (canonicalIds.length > 1) {
        throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', '本地 canonical parent 證據互相衝突', 409);
      }
      const canonicalParent = localCandidates[0] || null;
      const canary = evaluateParentIdentityCanary({
        lineUid,
        phone: phoneCanonical,
        sourceRecordIds: matchedFamilies.map((row) => row.z01_ragic_record_id),
        existingLocalLineUidFound: false,
      });
      const resolution = await resolveMultipleSourceCandidate(client, {
        matchedFamilies,
        exactMatches,
        canonicalParent,
        currentLineUid: lineUid,
        maxPriority: canary.allowed ? 6 : 3,
      });
      const winnerSet = resolution.winnerSourceId ? [resolution.winnerSourceId] : [];

      if (winnerSet.length === 1) {
        const winnerFamily = matchedFamilies.find((row) => String(row.z01_ragic_record_id) === String(winnerSet[0]));
        exactMatches = exactMatches.filter((row) => row.z03_record_id === winnerFamily.id);
        if (exactMatches.length !== 1) {
          throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', 'winner source 內仍有重複同名學員', 409);
        }
        aliasFamilies = matchedFamilies.filter((row) => row.id !== winnerFamily.id);
        resolutionMethod = `MULTIPLE_SOURCE_PRIORITY_${resolution.priority}`;
      } else {
        // Phone ownership + exact student name has been verified, but no source
        // is safe to make primary. Create/use one local identity, preserve every
        // source as an alias, enqueue no Ragic write, and allow login.
        if (canonicalParent?.line_uid && canonicalParent.line_uid !== lineUid) {
          throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', '手機已綁另一個 LINE UID', 409);
        }
        let parent = canonicalParent;
        if (!parent) {
          parent = (await client.query(
            `INSERT INTO parents (phone,name,line_uid,is_active)
             VALUES ($1,$2,$3,TRUE) RETURNING *`,
            [phoneCanonical, String(parentName || '').trim() || '未命名家長', lineUid]
          )).rows[0];
        } else if (!parent.line_uid) {
          parent = (await client.query(
            `UPDATE parents SET line_uid=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,
            [parent.id, lineUid]
          )).rows[0];
        }
        const studentRows = (await client.query(`SELECT * FROM students WHERE parent_id=$1 FOR UPDATE`, [parent.id])).rows
          .filter((row) => normalizeStudentName(row.name) === studentNameNormalized);
        if (studentRows.length > 1) throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', 'canonical student 命中多筆', 409);
        const student = studentRows[0] || (await client.query(
          `INSERT INTO students (parent_id,name,is_active) VALUES ($1,$2,TRUE) RETURNING *`,
          [parent.id, studentName]
        )).rows[0];
        await client.query(
          `UPDATE ragic_z03_students SET canonical_student_id=$2
            WHERE id=ANY($1::bigint[])`,
          [allExactMatchIds, student.id]
        );
        for (const source of matchedFamilies) {
          const claim = (await client.query(
            `INSERT INTO identity_claims
               (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
                canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
                last_error_code,correlation_id,verified_at,linked_at)
             VALUES ('CLAIM_LEGACY','DATA_RECONCILIATION_PENDING',$1,$2,$3,$4,$5,
                     'RAGIC','Z01',$6,'MULTIPLE_SOURCE_NO_UNIQUE_WINNER',$7,NOW(),NOW())
             ON CONFLICT (purpose,source_system,source_table,source_record_id,student_name_normalized)
             DO UPDATE SET state='DATA_RECONCILIATION_PENDING',canonical_parent_id=EXCLUDED.canonical_parent_id,
               canonical_student_id=EXCLUDED.canonical_student_id,last_error_code=EXCLUDED.last_error_code,
               version=identity_claims.version+1,updated_at=NOW()
             RETURNING *`,
            [phoneCanonical, studentNameNormalized, parent.id, student.id, _lineUidHash(lineUid),
             source.z01_ragic_record_id, correlationId]
          )).rows[0];
          await client.query(
            `INSERT INTO source_record_links
               (source_system,source_table,source_record_id,canonical_parent_id,
                canonical_student_id,claim_id,link_method)
             VALUES ('RAGIC','Z01',$1,$2,$3,$4,'MULTIPLE_SOURCE_ALIAS')
             ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
               canonical_parent_id=EXCLUDED.canonical_parent_id,
               canonical_student_id=EXCLUDED.canonical_student_id,claim_id=EXCLUDED.claim_id,
               link_method=EXCLUDED.link_method,updated_at=NOW()`,
            [source.z01_ragic_record_id, parent.id, student.id, claim.id]
          );
        }
        await client.query(
          `UPDATE ragic_z03_records SET status='resolved',classification='DATA_RECONCILIATION_PENDING',
             reason_code='MULTIPLE_SOURCE_NO_UNIQUE_WINNER',claim_state='DATA_RECONCILIATION_PENDING',
             canonical_parent_id=$2,canonical_student_id=$3,last_processed_at=NOW(),correlation_id=$4
           WHERE id=ANY($1::bigint[])`,
          [matchedFamilyIds, parent.id, student.id, correlationId]
        );
        await client.query('COMMIT');
        return { parent, student, replayed: false, sync_state: 'DATA_RECONCILIATION_PENDING',
          correlation_id: correlationId, ambiguous_source_resolved: false };
      }
    }

    const matchedChild = exactMatches[0];
    const family = families.find((row) => row.id === matchedChild.z03_record_id);
    if (!family) throw new Z03ClaimError('LOCAL_TRANSACTION_FAILED', 'Z03 family/child 關係不一致', 500);
    if (family.status === 'manual_review') {
      throw new Z03ClaimError('MANUAL_REVIEW_REQUIRED', '此 Z03 family 已進人工處理', 409, {
        reason: family.reason_code || 'MANUAL_REVIEW',
      });
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `ragic-z01:${family.z01_ragic_record_id}`,
    ]);

    const existingLink = (await client.query(
      `SELECT * FROM source_record_links
        WHERE source_system='RAGIC' AND source_table='Z01' AND source_record_id=$1
        FOR UPDATE`,
      [family.z01_ragic_record_id]
    )).rows[0] || null;
    if (existingLink) {
      const linkedParent = (await client.query(
        `SELECT * FROM parents WHERE id=$1 FOR UPDATE`, [existingLink.canonical_parent_id]
      )).rows[0];
      const linkedStudent = existingLink.canonical_student_id
        ? (await client.query(`SELECT * FROM students WHERE id=$1 FOR UPDATE`, [existingLink.canonical_student_id])).rows[0]
        : null;
      if (!linkedParent) throw new Z03ClaimError('ORPHAN_CLAIM_CONFLICT', 'source link parent 不存在', 409);
      if (normalizePhone(linkedParent.phone) !== phoneCanonical) {
        throw new Z03ClaimError('SOURCE_RECORD_ALREADY_LINKED', 'source record 已連結另一個 phone', 409);
      }
      if (linkedParent.line_uid && linkedParent.line_uid !== lineUid) {
        throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', '手機已綁定另一個 LINE UID', 409);
      }
      if (linkedStudent && normalizeStudentName(linkedStudent.name) !== studentNameNormalized) {
        throw new Z03ClaimError('SOURCE_RECORD_ALREADY_LINKED', 'source record 已連結另一位 student', 409);
      }
      if (linkedParent.line_uid !== lineUid) {
        await client.query(`UPDATE parents SET line_uid=$2, updated_at=NOW() WHERE id=$1`, [linkedParent.id, lineUid]);
        linkedParent.line_uid = lineUid;
      }
      if (linkedStudent) {
        await client.query(
          `UPDATE ragic_z03_records SET
             status='resolved', classification='RESOLVED', claim_state='SYNC_PENDING',
             canonical_parent_id=$2, canonical_student_id=$3,
             reason_code='CLAIM_REPLAY', last_error_code=NULL,
             resolved_at=COALESCE(resolved_at,NOW()), resolved_by=COALESCE(resolved_by,$4),
             last_processed_at=NOW(), correlation_id=COALESCE(correlation_id,$5::uuid)
           WHERE id=$1`,
          [family.id, linkedParent.id, linkedStudent.id, actor, correlationId]
        );
        await client.query('COMMIT');
        return { parent: linkedParent, student: linkedStudent, replayed: true, sync_state: 'SYNC_PENDING', correlation_id: correlationId };
      }
    }

    const parentRows = (await client.query(
      `SELECT * FROM parents
        WHERE phone=$1 OR regexp_replace(COALESCE(phone,''), '\\D', '', 'g')=$1
        ORDER BY created_at,id FOR UPDATE`,
      [phoneCanonical]
    )).rows;
    if (parentRows.length > 1) {
      reviewContext = { z03Ids: [family.id], sourceRecordId: family.z01_ragic_record_id, code: 'DUPLICATE_PARENT_IDENTITY' };
      throw new Z03ClaimError('DUPLICATE_PARENT_IDENTITY', 'canonical phone 命中多個 parent', 409);
    }
    const uidParent = (await client.query(`SELECT * FROM parents WHERE line_uid=$1 FOR UPDATE`, [lineUid])).rows[0] || null;
    let parent = parentRows[0] || null;
    if (uidParent && parent && uidParent.id !== parent.id) {
      throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', 'LINE UID 已綁另一個 parent', 409);
    }
    if (uidParent && !parent) {
      if (normalizePhone(uidParent.phone) !== phoneCanonical) {
        throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', 'LINE UID 已綁另一個 phone', 409);
      }
      parent = uidParent;
    }
    if (parent?.line_uid && parent.line_uid !== lineUid) {
      throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', '手機已綁另一個 LINE UID', 409);
    }

    if (!parent) {
      const displayName = String(parentName || family.raw_name || '').trim() || '未命名家長';
      parent = (await client.query(
        `INSERT INTO parents
           (phone,name,line_uid,gender,email,identity,home_phone,home_address,line_id,
            ragic_record_id,is_active,last_synced_at)
         VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),
                 NULLIF($8,''),NULLIF($9,''),$10,TRUE,NOW())
         RETURNING *`,
        [phoneCanonical, displayName, lineUid, family.gender_raw || '', family.email_raw || '',
         family.identity_raw || '', family.home_phone_raw || '', family.home_address_raw || '',
         family.line_id_raw || '', family.z01_ragic_record_id]
      )).rows[0];
    } else {
      parent = (await client.query(
        `UPDATE parents SET
           line_uid=COALESCE(line_uid,$2),
           name=CASE WHEN name='未命名家長' THEN COALESCE(NULLIF($3,''),NULLIF($4,''),name) ELSE name END,
           ragic_record_id=COALESCE(ragic_record_id,$5),
           is_active=TRUE, updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [parent.id, lineUid, String(parentName || '').trim(), family.raw_name || '', family.z01_ragic_record_id]
      )).rows[0];
    }

    const canonicalStudents = (await client.query(
      `SELECT * FROM students WHERE parent_id=$1 ORDER BY created_at,id FOR UPDATE`, [parent.id]
    )).rows.filter((row) => normalizeStudentName(row.name) === studentNameNormalized);
    if (canonicalStudents.length > 1) {
      reviewContext = { z03Ids: [family.id], sourceRecordId: family.z01_ragic_record_id, code: 'AMBIGUOUS_STUDENT_MATCH' };
      throw new Z03ClaimError('AMBIGUOUS_STUDENT_MATCH', 'canonical family 內同名 student 命中多筆', 409);
    }
    let student = canonicalStudents[0] || null;
    if (!student) {
      student = (await client.query(
        `INSERT INTO students
           (parent_id,name,birth_date,gender,blood_type,student_code,is_active,last_synced_at)
         VALUES ($1,$2,$3::date,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),TRUE,NOW())
         RETURNING *`,
        [parent.id, matchedChild.name_raw, _safeDate(matchedChild.birth_date_raw),
         matchedChild.gender_raw || '', matchedChild.blood_type_raw || '', matchedChild.student_code_raw || '']
      )).rows[0];
    }

    const claim = (await client.query(
      `INSERT INTO identity_claims
         (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
          canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
          correlation_id,verified_at,linked_at)
       VALUES ('CLAIM_LEGACY','SYNC_PENDING',$1,$2,$3,$4,$5,'RAGIC','Z01',$6,$7,NOW(),NOW())
       ON CONFLICT (purpose,source_system,source_table,source_record_id,student_name_normalized)
       DO UPDATE SET state='SYNC_PENDING', canonical_parent_id=EXCLUDED.canonical_parent_id,
                     canonical_student_id=EXCLUDED.canonical_student_id,
                     line_uid_hash=EXCLUDED.line_uid_hash, last_error_code=NULL,
                     version=identity_claims.version+1, updated_at=NOW(),
                     verified_at=COALESCE(identity_claims.verified_at,NOW()),
                     linked_at=COALESCE(identity_claims.linked_at,NOW())
       RETURNING *`,
      [phoneCanonical, studentNameNormalized, parent.id, student.id, _lineUidHash(lineUid),
       family.z01_ragic_record_id, correlationId]
    )).rows[0];

    await client.query(
      `INSERT INTO source_record_links
         (source_system,source_table,source_record_id,canonical_parent_id,
          canonical_student_id,claim_id,link_method)
       VALUES ('RAGIC','Z01',$1,$2,$3,$4,$5)
       ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
         canonical_parent_id=EXCLUDED.canonical_parent_id,
         canonical_student_id=EXCLUDED.canonical_student_id,
         claim_id=EXCLUDED.claim_id,
         link_method=EXCLUDED.link_method,
         updated_at=NOW()`,
      [family.z01_ragic_record_id, parent.id, student.id, claim.id, resolutionMethod]
    );
    await client.query(
      `UPDATE ragic_z03_students SET canonical_student_id=$2
        WHERE id=ANY($1::bigint[])`,
      [allExactMatchIds, student.id]
    );
    for (const alias of aliasFamilies) {
      await client.query(
        `INSERT INTO source_record_links
           (source_system,source_table,source_record_id,canonical_parent_id,
            canonical_student_id,claim_id,link_method)
         VALUES ('RAGIC','Z01',$1,$2,$3,$4,'MULTIPLE_SOURCE_ALIAS')
         ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
           canonical_parent_id=EXCLUDED.canonical_parent_id,
           canonical_student_id=EXCLUDED.canonical_student_id,
           claim_id=EXCLUDED.claim_id,link_method=EXCLUDED.link_method,updated_at=NOW()`,
        [alias.z01_ragic_record_id, parent.id, student.id, claim.id]
      );
    }
    if (aliasFamilies.length) {
      await client.query(
        `UPDATE ragic_z03_records SET status='resolved',classification='SOURCE_ALIAS',
           reason_code=$2,claim_state='ALIAS_LINKED',canonical_parent_id=$3,
           canonical_student_id=$4,last_processed_at=NOW(),correlation_id=$5
         WHERE id=ANY($1::bigint[])`,
        [aliasFamilies.map((row) => row.id), resolutionMethod, parent.id, student.id, claim.correlation_id]
      );
    }
    await client.query(
      `INSERT INTO identity_claim_events
         (claim_id,from_state,to_state,reason_code,actor_type,correlation_id)
       VALUES ($1,'MATCHED','SYNC_PENDING','LOCAL_LINK_COMMITTED',$2,$3)`,
      [claim.id, actor, claim.correlation_id]
    );
    await client.query(
      `INSERT INTO ragic_sync_outbox
         (idempotency_key,claim_id,operation,source_system,source_table,source_record_id,
          payload_reference,state,correlation_id,target_record_id,field_id)
       VALUES ($1,$2,'BIND_Z01_LINE_UID','RAGIC','Z01',$3,$4::jsonb,'pending',$5,$3,'1006846')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [`bind-z01-line-uid:${family.z01_ragic_record_id}`, claim.id, family.z01_ragic_record_id,
       JSON.stringify({ canonical_parent_id: parent.id }), claim.correlation_id]
    );
    await client.query(
      `UPDATE ragic_z03_records SET
         status='resolved', classification='RESOLVED', reason_code='CLAIM_LINKED_LOCAL',
         claim_state='SYNC_PENDING', canonical_parent_id=$2, canonical_student_id=$3,
         resolved_at=NOW(), resolved_by=$4, last_error_code=NULL,
         last_processed_at=NOW(), correlation_id=$5
       WHERE id=$1`,
      [family.id, parent.id, student.id, actor, claim.correlation_id]
    );

    await client.query('COMMIT');
    return { parent, student, replayed: false, sync_state: 'SYNC_PENDING', correlation_id: claim.correlation_id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (reviewContext) {
      await _persistManualReview({
        ...reviewContext,
        phoneCanonical,
        studentNameNormalized,
        lineUid,
        correlationId,
      }).catch((persistErr) => {
        err.manualReviewPersistenceError = persistErr.code || persistErr.message;
      });
    }
    if (err instanceof Z03ClaimError) throw err;
    if (err.code === '23505' && err.constraint === 'parents_line_uid_key') {
      throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', 'LINE UID unique constraint conflict', 409);
    }
    throw new Z03ClaimError('LOCAL_TRANSACTION_FAILED', '本地認領 transaction 失敗', 500, {
      constraint: err.constraint || null,
      causeCode: err.code || null,
    });
  } finally {
    client.release();
  }
}

module.exports = {
  Z03ClaimError,
  claimZ03Identity,
  registerNewParentLocalFirst,
  __test__: {
    safeDate: _safeDate,
    lineUidHash: _lineUidHash,
  },
};
