#!/usr/bin/env node
'use strict';

// Read-only reconciliation: every Ragic Z01 shadow record whose exact LINE UID
// field is blank must have one Z03 row in pending/resolved/manual_review.
const { pool } = require('../server/models/db');
const ragicAdmin = require('../server/services/ragicAdmin');
const ragic = require('../server/services/ragic');

async function liveCoverage() {
  const pageSize = Number(process.env.RAGIC_PAGE_SIZE) || 200;
  const records = [];
  let naturalEnd = false;
  for (let page = 0; page < 50; page++) {
    const result = await ragic.fetchPage(process.env.RAGIC_FORM_Z01, {
      limit: pageSize, offset: page * pageSize, order: '109,ASC', naming: 'EID',
    });
    records.push(...result.rows);
    if (result.count < pageSize) { naturalEnd = true; break; }
  }
  if (!naturalEnd) throw Object.assign(new Error('Ragic EID fetch hit page limit'), { code: 'RAGIC_FULL_FETCH_INCOMPLETE' });
  const liveIds = new Set(records.map((row) => String(row._ragicId || '')).filter(Boolean));
  const shadowIds = new Set((await pool.query(
    `SELECT ragic_record_id FROM ragic_z01_shadow WHERE present_in_latest_pull=TRUE`
  )).rows.map((row) => row.ragic_record_id));
  const liveMissingInShadow = [...liveIds].filter((id) => !shadowIds.has(id));
  const stalePresentShadow = [...shadowIds].filter((id) => !liveIds.has(id));
  const local = await ragicAdmin.reconcileZ01SourceCoverage();
  return {
    source: 'LIVE_RAGIC_READ_ONLY',
    ...local,
    fetched_count: records.length,
    live_shadow_source_set_match: liveMissingInShadow.length === 0 && stalePresentShadow.length === 0,
    live_missing_in_shadow_ids: liveMissingInShadow,
    stale_present_shadow_ids: stalePresentShadow,
    pass: local.pass && liveMissingInShadow.length === 0 && stalePresentShadow.length === 0,
  };
}

(async () => {
  const result = process.argv.includes('--live')
    ? await liveCoverage()
    : { source: 'LOCAL_RAGIC_Z01_SHADOW', ...(await ragicAdmin.reconcileZ01SourceCoverage()) };
  console.log(JSON.stringify({
    status: result.pass ? 'PASS' : 'BLOCKED',
    ...result,
  }, null, 2));
  process.exitCode = result.pass ? 0 : 2;
})().catch((err) => {
  console.error(JSON.stringify({
    status: 'BLOCKED',
    code: err.code || 'RECONCILIATION_FAILED',
    error: err.message,
  }));
  process.exitCode = 1;
}).finally(() => pool.end());
