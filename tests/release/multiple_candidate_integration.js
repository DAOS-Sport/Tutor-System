'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../../server/models/db');
const parentSync = require('../../server/services/parentSync');
const { claimZ03Identity } = require('../../server/services/z03IdentityClaim');
const {
  priority5RegistrationSourceEvidence,
  priority6UniqueWritableBlankSource,
} = require('../../server/services/parentIdentityResolver');

const suffix = `${Date.now()}`.slice(-6);
const ids = {
  p4a: `ZZ6786P4A${suffix}`,
  p4b: `ZZ6786P4B${suffix}`,
  p5a: `ZZ6786P5A${suffix}`,
  p5b: `ZZ6786P5B${suffix}`,
  p6a: `ZZ6786P6A${suffix}`,
  p6b: `ZZ6786P6B${suffix}`,
  noa: `ZZ6786NOA${suffix}`,
  nob: `ZZ6786NOB${suffix}`,
};
const allSourceIds = Object.values(ids);
const parentIds = [];

async function rightsSnapshot() {
  const queries = {
    course_periods: `SELECT COUNT(*)::bigint count,COALESCE(SUM(total_sessions),0)::text total,COALESCE(SUM(used_sessions),0)::text used,COALESCE(SUM(final_price),0)::text amount FROM course_periods`,
    course_period_enrollments: `SELECT COUNT(*)::bigint count FROM course_period_enrollments`,
    group_orders: `SELECT COUNT(*)::bigint count FROM group_orders`,
    group_order_members: `SELECT COUNT(*)::bigint count FROM group_order_members`,
    admin_enrollments: `SELECT COUNT(*)::bigint count,COALESCE(SUM(total_sessions),0)::text total,COALESCE(SUM(used_sessions),0)::text used,COALESCE(SUM(final_price),0)::text amount FROM admin_enrollments`,
  };
  const metrics = {};
  for (const [name, sql] of Object.entries(queries)) metrics[name] = (await pool.query(sql)).rows[0];
  return {
    metrics,
    hash: crypto.createHash('sha256').update(JSON.stringify(metrics)).digest('hex'),
  };
}

async function addCandidate({ sourceId, phone, studentName, rowKey = 'row-1', uid = '' }) {
  const z03 = (await pool.query(
    `INSERT INTO ragic_z03_records
       (z01_ragic_record_id,raw_name,phone,phone_canonical,status,classification,reason_code,claim_state)
     VALUES ($1,'6786 fixture',$2,$2,'pending','PENDING_Z03','TRUE_LINE_UID_EMPTY','UNRESOLVED')
     RETURNING *`, [sourceId, phone]
  )).rows[0];
  const child = (await pool.query(
    `INSERT INTO ragic_z03_students
       (z03_record_id,name_raw,name_normalized,source_row_key,classification,present_in_latest_payload)
     VALUES ($1,$2,$3,$4,'VALID',TRUE) RETURNING *`,
    [z03.id, studentName, studentName.replace(/\s/g, ''), rowKey]
  )).rows[0];
  await pool.query(
    `INSERT INTO ragic_z01_shadow
       (ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
     VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`,
    [sourceId, JSON.stringify({ _ragicId: sourceId, 1006846: uid })]
  );
  return { ...z03, child };
}

async function cleanup() {
  const claims = await pool.query(
    `SELECT id,canonical_parent_id FROM identity_claims WHERE source_record_id=ANY($1::text[])`, [allSourceIds]
  );
  const claimIds = claims.rows.map((row) => row.id);
  for (const row of claims.rows) if (row.canonical_parent_id) parentIds.push(row.canonical_parent_id);
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
  }
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id=ANY($1::text[]) OR source_record_id LIKE ANY($2::text[])`,
    [allSourceIds, allSourceIds.map((id) => `${id}:%`)]);
  if (claimIds.length) await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  await pool.query(`DELETE FROM ragic_source_identity_status_audit WHERE source_record_id=ANY($1::text[])`, [allSourceIds]);
  await pool.query(`DELETE FROM ragic_source_identity_status WHERE source_record_id=ANY($1::text[])`, [allSourceIds]);
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id=ANY($1::text[])`, [allSourceIds]);
  await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id=ANY($1::text[])`, [allSourceIds]);
  const uniqueParents = [...new Set(parentIds.filter(Boolean))];
  for (const parentId of uniqueParents) {
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
}

async function priority4Case() {
  const phone = `0941${suffix}`;
  const lineUid = `Up4${crypto.randomBytes(12).toString('hex')}`;
  const parent = (await pool.query(
    `INSERT INTO parents(phone,name,line_uid,is_active) VALUES ($1,'P4 parent',$2,TRUE) RETURNING *`,
    [phone, lineUid]
  )).rows[0];
  parentIds.push(parent.id);
  const student = (await pool.query(
    `INSERT INTO students(parent_id,name,is_active) VALUES ($1,'同一學員',TRUE) RETURNING *`, [parent.id]
  )).rows[0];
  const a = await addCandidate({ sourceId: ids.p4a, phone, studentName: '同一學員', rowKey: 'student-source-A' });
  await addCandidate({ sourceId: ids.p4b, phone, studentName: '同一 學員', rowKey: 'student-source-B' });
  await pool.query(
    `INSERT INTO source_record_links
       (source_system,source_table,source_record_id,canonical_parent_id,canonical_student_id,link_method)
     VALUES ('RAGIC','Z01_STUDENT',$1,$2,$3,'CANONICAL_STUDENT_SOURCE')`,
    [`${ids.p4a}:${a.child.source_row_key}`, parent.id, student.id]
  );
  const result = await claimZ03Identity({ phone, studentName: '同一學員', lineUid, parentName: 'P4 parent' });
  assert.strictEqual(result.parent.id, parent.id);
  const links = await pool.query(
    `SELECT source_record_id,link_method FROM source_record_links
      WHERE source_table='Z01' AND source_record_id=ANY($1::text[]) ORDER BY source_record_id`,
    [[ids.p4a, ids.p4b]]
  );
  assert.deepStrictEqual(links.rows, [
    { source_record_id: ids.p4a, link_method: 'MULTIPLE_SOURCE_PRIORITY_4' },
    { source_record_id: ids.p4b, link_method: 'MULTIPLE_SOURCE_ALIAS' },
  ]);
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int AS n FROM ragic_sync_outbox WHERE target_record_id=$1`, [ids.p4a]
  )).rows[0].n, 1);
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int AS n FROM ragic_sync_outbox WHERE target_record_id=$1`, [ids.p4b]
  )).rows[0].n, 0);
}

async function priority5NoDecisionCase() {
  const client = await pool.connect();
  try {
    const result = await priority5RegistrationSourceEvidence(client, {
      sourceIds: [ids.p5a, ids.p5b], canonicalParent: null,
    });
    assert.strictEqual(result.decision, 'NO_DECISION');
    assert.strictEqual(result.reason, 'NO_EXPLICIT_Z01_REGISTRATION_REFERENCE');
    assert.ok(result.discoveredColumns.group_orders);
    assert.ok(result.discoveredColumns.group_order_members);
    assert.ok(result.discoveredColumns.admin_enrollments);
  } finally { client.release(); }
}

async function priority6Case() {
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
     VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE),($3,$4::jsonb,NOW(),NOW(),TRUE)`,
    [ids.p6a, JSON.stringify({ _ragicId: ids.p6a, 1006846: '' }),
     ids.p6b, JSON.stringify({ _ragicId: ids.p6b, 1006846: 'Uexplicit-old' })]
  );
  const client = await pool.connect();
  try {
    const shadowRows = (await client.query(
      `SELECT ragic_record_id,raw_data FROM ragic_z01_shadow WHERE ragic_record_id=ANY($1::text[])`,
      [[ids.p6a, ids.p6b]]
    )).rows;
    const shadowBySource = new Map(shadowRows.map((row) => [row.ragic_record_id, row]));
    const before = await priority6UniqueWritableBlankSource(client, {
      sourceIds: [ids.p6a, ids.p6b], shadowBySource,
    });
    assert.strictEqual(before.decision, 'NO_DECISION');
    assert.strictEqual(before.reason, 'OTHER_SOURCES_NOT_EXPLICITLY_INVALID');
    const correlationId = crypto.randomUUID();
    await client.query(
      `INSERT INTO ragic_source_identity_status
         (source_system,source_table,source_record_id,status,reason,set_by,correlation_id)
       VALUES ('RAGIC','Z01',$1,'SUPERSEDED','verified duplicate source','release-admin',$2)`,
      [ids.p6b, correlationId]
    );
    await client.query(
      `INSERT INTO ragic_source_identity_status_audit
         (source_system,source_table,source_record_id,from_status,to_status,reason,actor,correlation_id)
       VALUES ('RAGIC','Z01',$1,NULL,'SUPERSEDED','verified duplicate source','release-admin',$2)`,
      [ids.p6b, correlationId]
    );
    const after = await priority6UniqueWritableBlankSource(client, {
      sourceIds: [ids.p6a, ids.p6b], shadowBySource,
    });
    assert.strictEqual(after.decision, 'WINNER');
    assert.strictEqual(after.winnerSourceId, ids.p6a);
  } finally { client.release(); }
}

async function noWinnerCase() {
  const beforeRights = await rightsSnapshot();
  const phone = `0942${suffix}`;
  const lineUid = `Uno${crypto.randomBytes(12).toString('hex')}`;
  await addCandidate({ sourceId: ids.noa, phone, studentName: '待整理學員', rowKey: 'no-a' });
  await addCandidate({ sourceId: ids.nob, phone, studentName: '待 整理學員', rowKey: 'no-b' });
  const first = await claimZ03Identity({ phone, studentName: '待整理學員', lineUid, parentName: '待整理家長' });
  parentIds.push(first.parent.id);
  assert.strictEqual(first.sync_state, 'DATA_RECONCILIATION_PENDING');
  assert.strictEqual((await parentSync.findActiveParentByLineUid(lineUid)).id, first.parent.id);
  const second = await claimZ03Identity({ phone, studentName: '待整理學員', lineUid, parentName: '待整理家長' });
  assert.strictEqual(second.parent.id, first.parent.id);
  const counts = (await pool.query(
    `SELECT
      (SELECT COUNT(*)::int FROM parents WHERE phone=$1) parents,
      (SELECT COUNT(*)::int FROM students WHERE parent_id=$2) students,
      (SELECT COUNT(*)::int FROM source_record_links WHERE source_record_id=ANY($3::text[])) aliases,
      (SELECT COUNT(*)::int FROM ragic_sync_outbox WHERE source_record_id=ANY($3::text[])) outbox`,
    [phone, first.parent.id, [ids.noa, ids.nob]]
  )).rows[0];
  assert.deepStrictEqual(counts, { parents: 1, students: 1, aliases: 2, outbox: 0 });
  const afterRights = await rightsSnapshot();
  assert.deepStrictEqual(afterRights, beforeRights, 'multiple-source identity resolution must not change rights');
  console.log(`rights_evidence before=${beforeRights.hash} after=${afterRights.hash} counts=${JSON.stringify(afterRights.metrics)}`);
}

(async () => {
  await cleanup();
  try {
    const selected = String(process.argv[2] || 'ALL').toUpperCase();
    if (selected === 'P4' || selected === 'ALL') {
      process.env.PARENT_IDENTITY_RESOLVER_V2 = 'true';
      process.env.PARENT_IDENTITY_CANARY_PHASE = 'percentage';
      process.env.PARENT_IDENTITY_CANARY_PERCENT = '100';
    }
    if (selected === 'P4' || selected === 'ALL') await priority4Case();
    if (selected === 'P5' || selected === 'ALL') await priority5NoDecisionCase();
    if (selected === 'P6' || selected === 'ALL') await priority6Case();
    if (selected === 'NO_WINNER' || selected === 'ALL') await noWinnerCase();
    if (!['P4','P5','P6','NO_WINNER','ALL'].includes(selected)) throw new Error(`unknown case ${selected}`);
    console.log(`multiple_candidate_integration ${selected}: PASS`);
  } finally {
    delete process.env.PARENT_IDENTITY_RESOLVER_V2;
    delete process.env.PARENT_IDENTITY_CANARY_PHASE;
    delete process.env.PARENT_IDENTITY_CANARY_PERCENT;
    await cleanup();
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
