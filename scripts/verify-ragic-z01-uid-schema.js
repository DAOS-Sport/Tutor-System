'use strict';

const { pool } = require('../server/models/db');
const { verifyRagicZ01UidSchemaFreshness } = require('../server/services/ragicSchemaFreshness');

(async () => {
  try {
    const evidence = await verifyRagicZ01UidSchemaFreshness();
    const safe = {
      schema_freshness_verified: evidence.verified,
      fetched_at: evidence.fetched_at,
      endpoint: evidence.endpoint,
      sheet_path: evidence.sheet_path,
      sheet_id: evidence.sheet_id,
      http_status: evidence.http_status,
      response_hash: evidence.response_hash,
      field_id: evidence.field_id,
      field_name: evidence.field_name,
      attr_noDup: evidence.attr_noDup,
      attr_must: evidence.attr_must,
      attr_ro: evidence.attr_ro,
      schema_version: evidence.schema_version,
      correlation_id: evidence.correlation_id,
      expires_at: evidence.expires_at,
      failure_code: evidence.failure_code,
    };
    console.log(JSON.stringify(safe, null, 2));
    if (!evidence.verified) process.exitCode = 2;
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(JSON.stringify({ schema_freshness_verified: false, code: err.code || 'RAGIC_SCHEMA_NOT_VERIFIED' }));
  process.exit(1);
});
