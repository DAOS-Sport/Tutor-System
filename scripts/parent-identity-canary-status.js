'use strict';

const { pool } = require('../server/models/db');
const ragicAdmin = require('../server/services/ragicAdmin');

(async () => {
  const [coverage, duplicates, outbox, schema] = await Promise.all([
    ragicAdmin.reconcileZ01SourceCoverage(),
    pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM (
          SELECT regexp_replace(COALESCE(phone,''),'\\D','','g') phone
            FROM parents WHERE is_active=TRUE
           GROUP BY 1 HAVING COUNT(*)>1
        ) q) duplicate_canonical_phone,
        (SELECT COUNT(*)::int FROM (
          SELECT line_uid FROM parents WHERE is_active=TRUE AND COALESCE(line_uid,'')<>''
           GROUP BY line_uid HAVING COUNT(*)>1
        ) q) duplicate_active_line_uid,
        (SELECT COUNT(*)::int FROM (
          SELECT source_system,source_table,source_record_id FROM source_record_links
           GROUP BY 1,2,3 HAVING COUNT(*)>1
        ) q) duplicate_active_source_link`
    ),
    pool.query(
      `SELECT state,COUNT(*)::int count,
              COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(created_at)))::int,0) oldest_age_seconds
         FROM ragic_sync_outbox WHERE state<>'synced' GROUP BY state ORDER BY state`
    ),
    pool.query(
      `SELECT fetched_at,expires_at,verified,failure_code,response_hash,correlation_id,
              field_id,field_name,attr_no_dup,attr_must,attr_ro
         FROM ragic_z01_uid_schema_verifications ORDER BY fetched_at DESC LIMIT 1`
    ),
  ]);
  const invariant = duplicates.rows[0];
  const schemaEvidence = schema.rows[0] || null;
  const schemaFresh = Boolean(schemaEvidence?.verified)
    && !schemaEvidence.failure_code
    && new Date(schemaEvidence.expires_at).getTime() > Date.now()
    && String(schemaEvidence.field_id) === '1006846'
    && schemaEvidence.field_name === '家教系統uid';
  const stop = coverage.missing_source_count > 0
    || invariant.duplicate_canonical_phone > 0
    || invariant.duplicate_active_line_uid > 0
    || invariant.duplicate_active_source_link > 0;
  console.log(JSON.stringify({
    status: stop ? 'ROLLBACK_REQUIRED' : (schemaFresh ? 'DB_INVARIANTS_PASS' : 'RAGIC_WRITES_BLOCKED'),
    checked_at: new Date().toISOString(),
    coverage,
    invariants: invariant,
    outbox: outbox.rows,
    schema: { ...schemaEvidence, fresh: schemaFresh },
    note: 'Application login-rate, Ragic-call, unexpected-logout, hard-delete and rights-delta metrics must also be supplied by deployment telemetry.',
  }, null, 2));
  process.exitCode = stop ? 2 : 0;
})().catch((err) => {
  console.error(JSON.stringify({ status: 'CHECK_FAILED', code: err.code || 'CANARY_STATUS_FAILED' }));
  process.exitCode = 1;
}).finally(() => pool.end());
