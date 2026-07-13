#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { pool } = require('../server/models/db');
const ragic = require('../server/services/ragic');
const ragicAdmin = require('../server/services/ragicAdmin');
const { getTrueRagicLineUid } = require('../server/config/ragicSchema');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

(async () => {
  const recordId = String(argValue('--record-id') || '').trim();
  if (!recordId) throw Object.assign(new Error('--record-id is required'), { code: 'RECORD_ID_REQUIRED' });
  const correlationId = crypto.randomUUID();
  const raw = await ragic.getRecordByRagicId(
    process.env.RAGIC_FORM_Z01,
    recordId,
    { ignoreFixedFilter: 'true', naming: 'EID' },
    { noCache: true }
  );
  if (!raw) throw Object.assign(new Error('source record not found'), { code: 'RAGIC_SOURCE_NOT_FOUND' });

  const pageSize = Number(process.env.RAGIC_PAGE_SIZE) || 200;
  let page = null;
  let offset = null;
  for (let index = 0; index < 50; index++) {
    const result = await ragic.fetchPage(process.env.RAGIC_FORM_Z01, {
      limit: pageSize, offset: index * pageSize, order: '109,ASC', naming: 'EID',
    });
    if (result.rows.some((row) => String(row._ragicId || '') === recordId)) {
      page = index;
      offset = index * pageSize;
      break;
    }
    if (result.count < pageSize) break;
  }
  const rawPayloadHash = crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  const preview = await ragicAdmin.reingestZ01Record(raw, { dryRun: true });
  const local = (await pool.query(
    `SELECT
       (SELECT jsonb_build_object('id',z.id,'status',z.status,'classification',z.classification,
          'reason_code',z.reason_code,'claim_state',z.claim_state,'correlation_id',z.correlation_id)
          FROM ragic_z03_records z WHERE z.z01_ragic_record_id=$1) AS z03,
       (SELECT jsonb_build_object('id',l.id,'canonical_parent_id',l.canonical_parent_id,
          'canonical_student_id',l.canonical_student_id,'link_method',l.link_method)
          FROM source_record_links l WHERE l.source_system='RAGIC' AND l.source_table='Z01'
            AND l.source_record_id=$1) AS source_link,
       (SELECT jsonb_build_object('id',c.id,'state',c.state,'last_error_code',c.last_error_code,
          'correlation_id',c.correlation_id) FROM identity_claims c
          WHERE c.source_system='RAGIC' AND c.source_table='Z01' AND c.source_record_id=$1
          ORDER BY c.updated_at DESC LIMIT 1) AS claim,
       (SELECT jsonb_build_object('id',o.id,'state',o.state,'last_error_code',o.last_error_code,
          'operation',o.operation) FROM ragic_sync_outbox o WHERE o.source_record_id=$1
          ORDER BY o.updated_at DESC LIMIT 1) AS sync`,
    [recordId]
  )).rows[0];

  console.log(JSON.stringify({
    correlation_id: correlationId,
    source: {
      fetched: true,
      endpoint: `${String(process.env.RAGIC_FORM_Z01 || '').split('?')[0]}/${recordId}`,
      sheet: 'Z01',
      naming: 'EID',
      page,
      offset,
      limit: pageSize,
      raw_payload_hash: rawPayloadHash,
    },
    filters: [
      { name: 'true_ragic_line_uid', input_field_id: '1006846', decision: Boolean(getTrueRagicLineUid(raw)),
        reason_code: getTrueRagicLineUid(raw) ? 'TRUE_LINE_UID_PRESENT' : 'TRUE_LINE_UID_EMPTY' },
      { name: 'line_chat_url', input_field_id: '1002390', identity_effect: false,
        present: Boolean(String(raw['1002390'] || '').trim()), reason_code: 'DISPLAY_FIELD_NOT_IDENTITY' },
      { name: 'parent_account_or_status_text', identity_effect: false,
        reason_code: 'DISPLAY_FIELD_NOT_IDENTITY' },
    ],
    parser: preview.student_rows,
    classification: {
      target: preview.target,
      reason_code: preview.reason_code,
      canonical_phone_present: preview.canonical_phone_present,
      canonical_phone_masked: preview.canonical_phone_masked,
    },
    local,
  }, null, 2));
})().catch((err) => {
  console.error(JSON.stringify({ status: 'BLOCKED', code: err.code || 'EXPLAIN_FAILED', error: err.message }));
  process.exitCode = 1;
}).finally(() => pool.end());
