#!/usr/bin/env node
'use strict';

// Default is read-only dry-run. Apply requires an explicit confirmation flag;
// each source record is handled in its own DB transaction and is idempotent.
const { pool } = require('../server/models/db');
const ragic = require('../server/services/ragic');
const ragicAdmin = require('../server/services/ragicAdmin');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

(async () => {
  const ids = String(argValue('--record-id') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!ids.length) throw Object.assign(new Error('--record-id is required (comma-separated ids allowed)'), { code: 'RECORD_ID_REQUIRED' });
  const apply = process.argv.includes('--apply');
  if (apply && !process.argv.includes('--confirm-write')) {
    throw Object.assign(new Error('--apply requires --confirm-write'), { code: 'WRITE_CONFIRMATION_REQUIRED' });
  }

  const results = [];
  for (const id of ids) {
    const raw = await ragic.getRecordByRagicId(
      process.env.RAGIC_FORM_Z01,
      id,
      { ignoreFixedFilter: 'true', naming: 'EID' },
      { noCache: true }
    );
    if (!raw) {
      results.push({ source_record_id: id, status: 'BLOCKED', code: 'RAGIC_SOURCE_NOT_FOUND' });
      continue;
    }
    try {
      const result = await ragicAdmin.reingestZ01Record(raw, { dryRun: !apply });
      results.push({ status: apply ? 'APPLIED' : 'DRY_RUN', ...result });
    } catch (err) {
      results.push({
        source_record_id: id,
        status: 'BLOCKED',
        code: err.code || 'REINGEST_FAILED',
        constraint: err.constraint || null,
      });
    }
  }
  const blocked = results.filter((result) => result.status === 'BLOCKED').length;
  console.log(JSON.stringify({
    mode: apply ? 'APPLY' : 'DRY_RUN',
    database_is_known_local_dev: /helium(?:db)?/i.test(String(process.env.DATABASE_URL || '')),
    processed: results.length,
    blocked,
    results,
  }, null, 2));
  process.exitCode = blocked ? 2 : 0;
})().catch((err) => {
  console.error(JSON.stringify({ status: 'BLOCKED', code: err.code || 'REINGEST_FAILED', error: err.message }));
  process.exitCode = 1;
}).finally(() => pool.end());
