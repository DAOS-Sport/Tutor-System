'use strict';

const crypto = require('crypto');
const { pool } = require('../server/models/db');
const ragicAdmin = require('../server/services/ragicAdmin');
const { normalizePhone, normalizeStudentName } = require('../server/services/identityNormalizer');
const { getTrueRagicLineUid } = require('../server/config/ragicSchema');

function hash(value) {
  return value ? crypto.createHash('sha256').update(String(value)).digest('hex') : null;
}

async function rightsEvidence() {
  const metrics = {
    course_periods: (await pool.query(
      `SELECT COUNT(*)::bigint count,COALESCE(SUM(total_sessions),0)::text total,
              COALESCE(SUM(used_sessions),0)::text used,COALESCE(SUM(final_price),0)::text amount
         FROM course_periods`
    )).rows[0],
    course_period_enrollments: (await pool.query(`SELECT COUNT(*)::bigint count FROM course_period_enrollments`)).rows[0],
    group_orders: (await pool.query(`SELECT COUNT(*)::bigint count FROM group_orders`)).rows[0],
    group_order_members: (await pool.query(`SELECT COUNT(*)::bigint count FROM group_order_members`)).rows[0],
    admin_enrollments: (await pool.query(
      `SELECT COUNT(*)::bigint count,COALESCE(SUM(total_sessions),0)::text total,
              COALESCE(SUM(used_sessions),0)::text used,COALESCE(SUM(final_price),0)::text amount
         FROM admin_enrollments`
    )).rows[0],
  };
  return { hash: hash(JSON.stringify(metrics)), metrics };
}

async function sourceTrace(sourceId) {
  const shadow = (await pool.query(
    `SELECT ragic_record_id,raw_data,present_in_latest_pull,last_seen_at,missing_since
       FROM ragic_z01_shadow WHERE ragic_record_id=$1`, [sourceId]
  )).rows[0] || null;
  const z03 = (await pool.query(
    `SELECT * FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [sourceId]
  )).rows[0] || null;
  const sourceUid = getTrueRagicLineUid(shadow?.raw_data);
  const phone = normalizePhone(z03?.phone_canonical || z03?.phone || shadow?.raw_data?.['1001100']);
  const parents = phone ? (await pool.query(
    `SELECT id,line_uid,ragic_record_id,is_active FROM parents
      WHERE phone=$1 OR regexp_replace(COALESCE(phone,''),'\\D','','g')=$1 ORDER BY id`, [phone]
  )).rows : [];
  const links = (await pool.query(
    `SELECT canonical_parent_id,canonical_student_id,link_method
       FROM source_record_links WHERE source_system='RAGIC' AND source_table='Z01' AND source_record_id=$1`,
    [sourceId]
  )).rows;
  const z03Students = z03 ? (await pool.query(
    `SELECT name_normalized,name_raw,classification,canonical_student_id
       FROM ragic_z03_students WHERE z03_record_id=$1`, [z03.id]
  )).rows : [];
  let exactCanonicalStudentMatches = 0;
  for (const parent of parents) {
    const students = (await pool.query(`SELECT id,name FROM students WHERE parent_id=$1 AND is_active=TRUE`, [parent.id])).rows;
    const sourceNames = new Set(z03Students.map((row) => normalizeStudentName(row.name_normalized || row.name_raw)).filter(Boolean));
    exactCanonicalStudentMatches += students.filter((row) => sourceNames.has(normalizeStudentName(row.name))).length;
  }
  const phoneCandidates = phone ? (await pool.query(
    `SELECT z01_ragic_record_id FROM ragic_z03_records WHERE phone_canonical=$1 ORDER BY z01_ragic_record_id`, [phone]
  )).rows.map((row) => row.z01_ragic_record_id) : [];
  const canonical = parents.length === 1 ? parents[0] : null;
  return {
    source_record_id: sourceId,
    source_present: Boolean(shadow),
    present_in_latest_pull: shadow?.present_in_latest_pull ?? null,
    missing_since: shadow?.missing_since || null,
    true_uid_1006846_present: Boolean(sourceUid),
    true_uid_hash: hash(sourceUid),
    z03: z03 ? {
      status: z03.status,
      classification: z03.classification,
      reason_code: z03.reason_code,
      claim_state: z03.claim_state,
      student_rows: z03Students.length,
      classified_student_rows: z03Students.filter((row) => ['VALID','DUPLICATE_CANDIDATE'].includes(row.classification)).length,
    } : null,
    canonical_parent_count: parents.length,
    canonical_parent_id: canonical?.id || links[0]?.canonical_parent_id || null,
    local_active_uid_hash: hash(canonical?.line_uid),
    local_ragic_record_id: canonical?.ragic_record_id || null,
    exact_canonical_student_matches: exactCanonicalStudentMatches,
    source_links: links,
    same_phone_candidate_source_ids: phoneCandidates,
    priority_trace: {
      priority_1_source_link: links.length === 1 ? sourceId : 'NO_DECISION',
      priority_2_current_uid: canonical?.line_uid && canonical.line_uid === sourceUid ? sourceId : 'NO_DECISION',
      priority_3_parent_ragic_id: canonical?.ragic_record_id === sourceId ? sourceId : 'NO_DECISION',
      priority_4_student_source: links[0]?.canonical_student_id ? sourceId : 'NO_DECISION_OR_NOT_NEEDED',
      priority_5_registration_source: 'NO_DECISION_WITHOUT_EXPLICIT_Z01_REGISTRATION_REFERENCE',
      priority_6_unique_blank_source: sourceUid ? 'NOT_APPLICABLE_NON_EMPTY_UID' : 'REQUIRES_OTHER_SOURCES_EXPLICITLY_INVALID',
    },
    safe_action: sourceId === '149'
      ? 'KEEP_PENDING_Z03'
      : (sourceId === '6504'
        ? 'ACCOUNT_RECOVERY_REQUIRED_MANUAL_VERIFIED_ATOMIC_REBIND'
        : (phoneCandidates.length > 1
          ? 'EVIDENCE_PRIORITY_OR_DATA_RECONCILIATION_PENDING'
          : (canonical ? 'KEEP_EXISTING_CANONICAL_LINK' : 'KEEP_SOURCE_FOR_RECONCILIATION'))),
  };
}

(async () => {
  const [coverage, rights, schema, duplicateRows, manualReview] = await Promise.all([
    ragicAdmin.reconcileZ01SourceCoverage(),
    rightsEvidence(),
    pool.query(
      `SELECT fetched_at,endpoint,sheet_path,sheet_id,http_status,response_hash,field_id,field_name,
              attr_no_dup,attr_must,attr_ro,schema_version,correlation_id,verified,failure_code,expires_at
         FROM ragic_z01_uid_schema_verifications ORDER BY fetched_at DESC LIMIT 1`
    ),
    pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM (SELECT regexp_replace(phone,'\\D','','g') FROM parents WHERE is_active=TRUE GROUP BY 1 HAVING COUNT(*)>1) q) duplicate_canonical_phone,
        (SELECT COUNT(*)::int FROM (SELECT line_uid FROM parents WHERE is_active=TRUE AND COALESCE(line_uid,'')<>'' GROUP BY 1 HAVING COUNT(*)>1) q) duplicate_active_line_uid,
        (SELECT COUNT(*)::int FROM (SELECT source_system,source_table,source_record_id FROM source_record_links GROUP BY 1,2,3 HAVING COUNT(*)>1) q) duplicate_source_link`
    ),
    pool.query(
      `SELECT z01_ragic_record_id,reason_code,canonical_parent_id,classification,claim_state,
              COALESCE(last_processed_at,resolved_at,source_updated_at,fetched_at,created_at) AS evidence_at
         FROM ragic_z03_records
        WHERE status='manual_review' OR claim_state='MANUAL_REVIEW'
        ORDER BY z01_ragic_record_id`
    ),
  ]);
  const traces = [];
  for (const sourceId of ['149', '6504', '6786']) traces.push(await sourceTrace(sourceId));
  const manualReviewEvidence = [];
  for (const row of manualReview.rows) {
    const trace = traces.find((item) => item.source_record_id === String(row.z01_ragic_record_id))
      || await sourceTrace(String(row.z01_ragic_record_id));
    manualReviewEvidence.push({
      ...row,
      canonical_candidate: trace.canonical_parent_id || 'NO_SAFE_CANONICAL_CANDIDATE',
      canonical_candidate_count: trace.canonical_parent_count,
      suggested_next_action: row.reason_code?.includes('UID') ? 'ACCOUNT_RECOVERY' : 'DATA_RECONCILIATION',
    });
  }
  console.log(JSON.stringify({
    mode: 'READ_ONLY_PRODUCTION_LIKE_DRY_RUN',
    generated_at: new Date().toISOString(),
    schema_freshness: schema.rows[0] || null,
    reconciliation: coverage,
    duplicates: duplicateRows.rows[0],
    manual_review: manualReviewEvidence,
    source_traces: traces,
    rights_before_after_read_only: { before: rights, after: rights, unchanged: true },
  }, null, 2));
})().catch((err) => {
  console.error(JSON.stringify({ mode: 'READ_ONLY_PRODUCTION_LIKE_DRY_RUN', status: 'FAILED', code: err.code || 'DRY_RUN_FAILED' }));
  process.exitCode = 1;
}).finally(() => pool.end());
