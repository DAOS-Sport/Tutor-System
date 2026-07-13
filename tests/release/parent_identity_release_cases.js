'use strict';

const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const express = require('express');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');
const ragicAdmin = require('../../server/services/ragicAdmin');
const parentSync = require('../../server/services/parentSync');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const { getSecret } = require('../../server/middlewares/adminAuth');
const {
  RAGIC_Z01_FIELDS,
  getTrueRagicLineUid,
} = require('../../server/config/ragicSchema');
const {
  claimZ03Identity,
  registerNewParentLocalFirst,
} = require('../../server/services/z03IdentityClaim');
const { requestAccountRecovery } = require('../../server/services/parentAccountRecovery');
const { resolveMultipleSourceCandidate } = require('../../server/services/parentIdentityResolver');

const testId = String(process.argv[2] || '').toUpperCase();
const suffix = `${Date.now()}`.slice(-6);
const sourceIds = [];
const parentIds = [];
const requestKeys = [];

function phoneFor(n) { return `09${String(n).padStart(2, '0')}${suffix}`; }
function uid(label) { return `U${label}${crypto.randomBytes(12).toString('hex')}`; }

async function cleanup() {
  const sources = [...new Set(sourceIds)];
  const parents = [...new Set(parentIds.filter(Boolean))];
  if (parents.length) {
    const recoveries = await pool.query(
      `SELECT id,claim_id FROM parent_account_recovery_requests WHERE canonical_parent_id=ANY($1::uuid[])`, [parents]
    );
    const recoveryIds = recoveries.rows.map((row) => row.id);
    const recoveryClaims = recoveries.rows.map((row) => row.claim_id).filter(Boolean);
    if (recoveryIds.length) {
      await pool.query(`DELETE FROM parent_account_recovery_events WHERE recovery_request_id=ANY($1::uuid[])`, [recoveryIds]);
      await pool.query(`DELETE FROM parent_line_uid_rebind_audit WHERE recovery_request_id=ANY($1::uuid[])`, [recoveryIds]);
      await pool.query(`DELETE FROM parent_account_recovery_requests WHERE id=ANY($1::uuid[])`, [recoveryIds]);
    }
    if (recoveryClaims.length) {
      await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [recoveryClaims]);
      await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [recoveryClaims]);
      await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [recoveryClaims]);
    }
  }
  let claims = [];
  if (sources.length) {
    claims = (await pool.query(
      `SELECT id FROM identity_claims WHERE source_record_id=ANY($1::text[])`, [sources]
    )).rows.map((row) => row.id);
  }
  if (claims.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claims]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claims]);
  }
  if (sources.length) {
    await pool.query(
      `DELETE FROM source_record_links WHERE source_record_id=ANY($1::text[]) OR source_record_id LIKE ANY($2::text[])`,
      [sources, sources.map((id) => `${id}:%`)]
    );
  }
  if (requestKeys.length) {
    await pool.query(`DELETE FROM parent_identity_requests WHERE idempotency_key=ANY($1::text[])`, [requestKeys]);
  }
  if (claims.length) await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claims]);
  if (sources.length) {
    await pool.query(`DELETE FROM ragic_source_identity_status_audit WHERE source_record_id=ANY($1::text[])`, [sources]);
    await pool.query(`DELETE FROM ragic_source_identity_status WHERE source_record_id=ANY($1::text[])`, [sources]);
    await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id=ANY($1::text[])`, [sources]);
    await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id=ANY($1::text[])`, [sources]);
  }
  for (const parentId of parents) {
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
}

async function makeParent({ phone, lineUid, ragicRecordId = null, studentName = 'release student' }) {
  const parent = (await pool.query(
    `INSERT INTO parents(phone,name,line_uid,ragic_record_id,is_active)
     VALUES ($1,'release parent',$2,$3,TRUE) RETURNING *`, [phone, lineUid || null, ragicRecordId]
  )).rows[0];
  parentIds.push(parent.id);
  const student = (await pool.query(
    `INSERT INTO students(parent_id,name,is_active) VALUES ($1,$2,TRUE) RETURNING *`,
    [parent.id, studentName]
  )).rows[0];
  return { parent, student };
}

async function makeCandidate({ sourceId, phone, studentName = 'release student', rowKey = 'row-1', lineUid = '' }) {
  sourceIds.push(sourceId);
  const family = (await pool.query(
    `INSERT INTO ragic_z03_records
       (z01_ragic_record_id,raw_name,phone,phone_canonical,status,classification,reason_code,claim_state)
     VALUES ($1,'release source',$2,$2,'pending','PENDING_Z03','TRUE_LINE_UID_EMPTY','UNRESOLVED')
     RETURNING *`, [sourceId, phone]
  )).rows[0];
  const child = (await pool.query(
    `INSERT INTO ragic_z03_students
       (z03_record_id,name_raw,name_normalized,source_row_key,classification,present_in_latest_payload)
     VALUES ($1,$2,$3,$4,'VALID',TRUE) RETURNING *`,
    [family.id, studentName, studentName.replace(/\s/g, ''), rowKey]
  )).rows[0];
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
     VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`,
    [sourceId, JSON.stringify({ _ragicId: sourceId, 1006846: lineUid })]
  );
  return { family, child };
}

async function localLoginCase({ assertCalls = false, offline = false }) {
  const lineUid = uid(testId);
  const { parent } = await makeParent({ phone: phoneFor(1), lineUid });
  const originalPost = axios.post;
  const originals = {};
  let ragicCalls = 0;
  for (const name of ['getParentByPhone','getParentByLineUid','upsertParentStrict','createParentWithStudentsInRagic']) {
    originals[name] = ragic[name];
    ragic[name] = async () => { ragicCalls += 1; if (offline) throw new Error('Ragic offline'); return null; };
  }
  axios.post = async () => ({ status: 200, data: { sub: lineUid, aud: 'release-channel' } });
  process.env.LINE_LOGIN_CHANNEL_ID = 'release-channel';
  delete require.cache[require.resolve('../../server/services/lineAuth')];
  delete require.cache[require.resolve('../../server/routes/auth')];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../server/routes/auth'));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/parent-line-login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: 'release-token' }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.status, 'logged_in');
    assert.strictEqual(body.parent.id, parent.id);
    assert.ok(body.token);
    if (assertCalls) assert.strictEqual(ragicCalls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    axios.post = originalPost;
    Object.assign(ragic, originals);
  }
}

async function T01() { await localLoginCase({}); }
async function T02() {
  const lineUid = uid('T02');
  const { parent } = await makeParent({ phone: phoneFor(2), lineUid });
  const before = signParentToken({ parentId: parent.id, phone: parent.phone, lineUid });
  delete require.cache[require.resolve('../../server/middlewares/parentAuth')];
  const payload = jwt.verify(before, getSecret());
  assert.strictEqual(payload.parentId, parent.id);
  assert.strictEqual(payload.type, 'parent');
}
async function T03() { await localLoginCase({ assertCalls: true }); }
async function T04() { await localLoginCase({ assertCalls: true, offline: true }); }
async function T05() {
  assert.strictEqual(RAGIC_Z01_FIELDS.PARENT_SYSTEM_LINE_UID, '1006846');
  assert.strictEqual(getTrueRagicLineUid({ 1006846: 'Utrue', 家教系統uid: 'Uwrong' }), 'Utrue');
  assert.strictEqual(getTrueRagicLineUid({ 家教系統uid: 'Uwrong' }), '');
}
async function T06() {
  assert.strictEqual(getTrueRagicLineUid({ 1002390: 'https://line.me/R/ti/p/Ufake', 'line對話網址': 'Ufake' }), '');
}
async function T07() {
  const row = (await pool.query(
    `SELECT z.status,z.classification,z.reason_code,z.claim_state,s.raw_data->>'1006846' uid,
       (SELECT COUNT(*)::int FROM ragic_z03_students zs WHERE zs.z03_record_id=z.id) student_rows,
       (SELECT COUNT(*)::int FROM ragic_z03_students zs WHERE zs.z03_record_id=z.id AND zs.classification IN ('VALID','DUPLICATE_CANDIDATE')) classified_rows
     FROM ragic_z03_records z JOIN ragic_z01_shadow s ON s.ragic_record_id=z.z01_ragic_record_id
     WHERE z.z01_ragic_record_id='149'`
  )).rows[0];
  assert.ok(row);
  assert.strictEqual(row.uid, '');
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.classification, 'PENDING_Z03');
  assert.strictEqual(row.student_rows, row.classified_rows);
}

async function singleClaim(caseId) {
  const phone = phoneFor(Number(caseId.slice(1)));
  const lineUid = uid(caseId);
  const sourceId = `ZZ${caseId}${suffix}`;
  await makeCandidate({ sourceId, phone, studentName: '唯一學員' });
  const first = await claimZ03Identity({ phone, studentName: '唯一學員', lineUid, parentName: '唯一家長' });
  parentIds.push(first.parent.id);
  return { phone, lineUid, sourceId, first };
}
async function T08() {
  const { sourceId } = await singleClaim('T08');
  const job = (await pool.query(
    `SELECT operation,target_record_id,field_id FROM ragic_sync_outbox WHERE source_record_id=$1`, [sourceId]
  )).rows[0];
  assert.deepStrictEqual(job, { operation: 'BIND_Z01_LINE_UID', target_record_id: sourceId, field_id: '1006846' });
}
async function T09() {
  const { phone } = await singleClaim('T09');
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM parents WHERE phone=$1`, [phone])).rows[0].n, 1);
}
async function T10() {
  const { first } = await singleClaim('T10');
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM students WHERE parent_id=$1`, [first.parent.id])).rows[0].n, 1);
}
async function T11() {
  const phone = phoneFor(11);
  const lineUid = uid('T11');
  const a = `ZZT11A${suffix}`;
  const b = `ZZT11B${suffix}`;
  await makeCandidate({ sourceId: a, phone, studentName: '別名學員', rowKey: 'a' });
  await makeCandidate({ sourceId: b, phone, studentName: '別名 學員', rowKey: 'b' });
  const result = await claimZ03Identity({ phone, studentName: '別名學員', lineUid, parentName: '別名家長' });
  parentIds.push(result.parent.id);
  const links = await pool.query(
    `SELECT source_record_id FROM source_record_links WHERE source_record_id=ANY($1::text[])`, [[a, b]]
  );
  assert.strictEqual(links.rowCount, 2);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM parents WHERE phone=$1`, [phone])).rows[0].n, 1);
}
async function T12() {
  const fixture = await singleClaim('T12');
  const replay = await claimZ03Identity({ phone: fixture.phone, studentName: '唯一學員', lineUid: fixture.lineUid });
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.parent.id, fixture.first.parent.id);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM ragic_sync_outbox WHERE source_record_id=$1`, [fixture.sourceId])).rows[0].n, 1);
}
async function T13() {
  const phone = phoneFor(13);
  const sourceId = `ZZT13${suffix}`;
  sourceIds.push(sourceId);
  const oldUid = uid('old13');
  const nextUid = uid('new13');
  const { parent, student } = await makeParent({ phone, lineUid: oldUid, ragicRecordId: sourceId, studentName: '恢復學員' });
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
     VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`, [sourceId, JSON.stringify({ _ragicId: sourceId, 1006846: oldUid })]
  );
  await pool.query(
    `INSERT INTO source_record_links(source_system,source_table,source_record_id,canonical_parent_id,canonical_student_id,link_method)
     VALUES ('RAGIC','Z01',$1,$2,$3,'RECOVERY_FIXTURE')`, [sourceId, parent.id, student.id]
  );
  const request = await requestAccountRecovery({ phone, studentName: '恢復學員', newLineUid: nextUid, ragicRecordId: sourceId });
  assert.strictEqual(request.state, 'ACCOUNT_RECOVERY_REQUIRED');
  assert.ok(request.recovery_token);
  assert.strictEqual((await parentSync.findActiveParentByLineUid(oldUid)).id, parent.id);
  assert.strictEqual(await parentSync.findActiveParentByLineUid(nextUid), null);
}

async function resolverFixture(priority) {
  const phone = phoneFor(priority + 20);
  const currentUid = uid(`p${priority}`);
  const aId = `ZZP${priority}A${suffix}`;
  const bId = `ZZP${priority}B${suffix}`;
  let parent = null;
  let student = null;
  if (priority === 1 || priority === 3) {
    ({ parent, student } = await makeParent({
      phone, lineUid: currentUid, ragicRecordId: priority === 3 ? bId : null, studentName: '證據學員',
    }));
  }
  const a = await makeCandidate({ sourceId: aId, phone, studentName: '證據學員', rowKey: 'a', lineUid: priority === 2 ? currentUid : '' });
  const b = await makeCandidate({ sourceId: bId, phone, studentName: '證據 學員', rowKey: 'b' });
  if (priority === 1) {
    await pool.query(
      `INSERT INTO source_record_links(source_system,source_table,source_record_id,canonical_parent_id,canonical_student_id,link_method)
       VALUES ('RAGIC','Z01',$1,$2,$3,'EXISTING_PRIMARY_SOURCE')`, [aId, parent.id, student.id]
    );
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await resolveMultipleSourceCandidate(client, {
      matchedFamilies: [a.family, b.family],
      exactMatches: [a.child, b.child],
      canonicalParent: parent,
      currentLineUid: currentUid,
    });
    await client.query('ROLLBACK');
    return { result, aId, bId };
  } finally { client.release(); }
}
async function T14() { const { result, aId } = await resolverFixture(1); assert.strictEqual(result.priority, 1); assert.strictEqual(result.winnerSourceId, aId); }
async function T15() { const { result, aId } = await resolverFixture(2); assert.strictEqual(result.priority, 2); assert.strictEqual(result.winnerSourceId, aId); }
async function T16() { const { result, bId } = await resolverFixture(3); assert.strictEqual(result.priority, 3); assert.strictEqual(result.winnerSourceId, bId); }

async function T21() {
  const phone = phoneFor(41);
  const lineUid = uid('T21');
  const key = `T21-${suffix}`;
  requestKeys.push(key);
  const result = await registerNewParentLocalFirst({
    parent: { name: 'zero match parent', phone }, students: [{ name: 'zero match student' }],
    lineUid, idempotencyKey: key,
  });
  parentIds.push(result.parent.id);
  const job = (await pool.query(
    `SELECT operation,source_record_id FROM ragic_sync_outbox WHERE idempotency_key=$1`, [`create-z01-parent:${key}`]
  )).rows[0];
  assert.strictEqual(job.operation, 'CREATE_Z01_PARENT');
  assert.strictEqual(job.source_record_id, `PENDING:${key}`);
  sourceIds.push(`PENDING:${key}`);
}

async function T23() {
  const sourceId = `ZZT23${suffix}`;
  sourceIds.push(sourceId);
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull,missing_since)
     VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE,NULL)`, [sourceId, JSON.stringify({ _ragicId: sourceId, 1006846: '' })]
  );
  const before = (await pool.query(`SELECT * FROM ragic_z01_shadow WHERE ragic_record_id=$1`, [sourceId])).rows[0];
  const original = ragic.getAllParentsWithIntegrityAndFreshness;
  ragic.getAllParentsWithIntegrityAndFreshness = async () => ({
    records: [], truncated: true, boundaryMismatch: false,
    freshness: { freshness_verified: true, freshness_latency_ms: 1, stale_retries: 0 },
  });
  try {
    const result = await ragicAdmin.__test__.shadowPullZ01Impl({ incremental: false });
    assert.ok(result.error && /截斷/.test(result.error));
  } finally { ragic.getAllParentsWithIntegrityAndFreshness = original; }
  const after = (await pool.query(`SELECT * FROM ragic_z01_shadow WHERE ragic_record_id=$1`, [sourceId])).rows[0];
  assert.strictEqual(after.present_in_latest_pull, true);
  assert.strictEqual(after.missing_since, null);
  assert.strictEqual(after.raw_data._ragicId, before.raw_data._ragicId);
}

const CASES = { T01,T02,T03,T04,T05,T06,T07,T08,T09,T10,T11,T12,T13,T14,T15,T16,T21,T23 };

(async () => {
  if (!CASES[testId]) throw new Error(`unknown or unsupported test id: ${testId}`);
  await cleanup();
  try {
    await CASES[testId]();
    console.log(`${testId}: PASS`);
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
