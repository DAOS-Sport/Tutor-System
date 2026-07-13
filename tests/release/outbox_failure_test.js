'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../../server/models/db');
const parentSync = require('../../server/services/parentSync');
const { claimZ03Identity } = require('../../server/services/z03IdentityClaim');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');

const suffix = `${Date.now()}`.slice(-6);
const phone = `0962${suffix}`;
const lineUid = `Udeadletter${crypto.randomBytes(12).toString('hex')}`;
const sourceId = `ZZDEAD${suffix}`;
let parentId = null;

async function cleanup() {
  const claims = await pool.query(`SELECT id,canonical_parent_id FROM identity_claims WHERE source_record_id=$1`, [sourceId]);
  const claimIds = claims.rows.map((row) => row.id);
  parentId = parentId || claims.rows.find((row) => row.canonical_parent_id)?.canonical_parent_id || null;
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
  }
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

(async () => {
  await cleanup();
  try {
    const family = (await pool.query(
      `INSERT INTO ragic_z03_records
         (z01_ragic_record_id,raw_name,phone,phone_canonical,status,classification,reason_code,claim_state)
       VALUES ($1,'dead letter',$2,$2,'pending','PENDING_Z03','TRUE_LINE_UID_EMPTY','UNRESOLVED') RETURNING id`,
      [sourceId, phone]
    )).rows[0];
    await pool.query(
      `INSERT INTO ragic_z03_students(z03_record_id,name_raw,name_normalized,source_row_key,classification,present_in_latest_payload)
       VALUES ($1,'阻擋學員','阻擋學員','row-1','VALID',TRUE)`, [family.id]
    );
    await pool.query(
      `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
       VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`, [sourceId, JSON.stringify({ _ragicId: sourceId, 1006846: '' })]
    );
    const claim = await claimZ03Identity({ phone, studentName: '阻擋學員', lineUid, parentName: '阻擋家長' });
    parentId = claim.parent.id;
    const result = await processRagicSyncOutbox({
      limit: 1,
      idempotencyKey: `bind-z01-line-uid:${sourceId}`,
      schemaGuard: async () => ({ verified: true }),
      writer: async () => { const err = new Error('validation'); err.code = 'RAGIC_VALIDATION_ERROR'; throw err; },
    });
    assert.deepStrictEqual(result, { processed: 1, synced: 0, retryable: 0, blocked: 1 });
    const job = (await pool.query(
      `SELECT state,last_error_code FROM ragic_sync_outbox WHERE source_record_id=$1`, [sourceId]
    )).rows[0];
    assert.deepStrictEqual(job, { state: 'blocked_schema', last_error_code: 'RAGIC_VALIDATION_ERROR' });
    assert.strictEqual((await parentSync.findActiveParentByLineUid(lineUid)).id, parentId);
    console.log('outbox_failure_test: PASS (non-retryable blocked, local login retained)');
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
