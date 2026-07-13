'use strict';

const assert = require('assert');
const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');
const ragicAdmin = require('../../server/services/ragicAdmin');
const {
  claimZ03Identity,
} = require('../../server/services/z03IdentityClaim');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');
const { PROFILE_PATCH_ALLOWLIST } = require('../../server/services/parentRegistrationProfile');

const testId = String(process.argv[2] || '').toUpperCase();
const suffix = `${Date.now()}`.slice(-6);
const sourceIds = [];
const parentIds = [];
const correlationIds = [];

function phoneFor(n) { return `098${String(n).padStart(1, '0')}${suffix}`; }
function uid(label) { return `U${label}${crypto.randomBytes(12).toString('hex')}`; }

async function rightsSnapshot() {
  const queries = {
    orders: `SELECT id,leader_parent_id,status,submitted_at,reviewed_at,period_count,roster_approved
               FROM group_orders ORDER BY id`,
    order_members: `SELECT id,group_order_id,parent_id,student_ids,status FROM group_order_members ORDER BY id`,
    enrollments: `SELECT id,parent_phone,status,total_sessions,used_sessions,final_price,refund_amount,
                         experience_checked_in_at,refunded_at,group_order_id
                    FROM admin_enrollments ORDER BY id`,
    purchased_remaining_lessons: `SELECT id,total_sessions,used_sessions,status,admin_enrollment_id,group_order_id
                                     FROM course_periods ORDER BY id`,
    course_enrollments: `SELECT id,course_period_id,student_id,status FROM course_period_enrollments ORDER BY id`,
    attendance: `SELECT id,course_session_id,student_id,is_auto_linked,checked_in_at,checked_in_source
                   FROM checkin_records ORDER BY id`,
  };
  const value = {};
  for (const [key, sql] of Object.entries(queries)) value[key] = (await pool.query(sql)).rows;
  return {
    hash: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    counts: Object.fromEntries(Object.entries(value).map(([key, rows]) => [key, rows.length])),
  };
}

async function addFamily({ sourceId, phone, email = '', student = null, rawName = '' }) {
  sourceIds.push(sourceId);
  const family = (await pool.query(
    `INSERT INTO ragic_z03_records
       (z01_ragic_record_id,raw_name,phone,phone_canonical,email_raw,status,classification,reason_code,claim_state)
     VALUES ($1,$2,$3,$3,$4,'pending','PENDING_Z03','TRUE_LINE_UID_EMPTY','UNRESOLVED') RETURNING *`,
    [sourceId, rawName || '舊家長', phone, email]
  )).rows[0];
  if (student) {
    await pool.query(
      `INSERT INTO ragic_z03_students
         (z03_record_id,name_raw,name_normalized,source_row_key,classification,present_in_latest_payload)
       VALUES ($1,$2,$3,'row-1','VALID',TRUE)`,
      [family.id, student.name, student.name.replace(/\s/g, '').toLowerCase()]
    );
  }
  const raw = {
    _ragicId: sourceId,
    1006846: '',
    1001100: phone,
    1001101: rawName || '舊家長',
    1002820: email,
    _subtable_1001119: student ? {
      0: { 1001115: student.name, 1001116: student.birth_date || '2014/01/02' },
    } : {},
  };
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
     VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`, [sourceId, JSON.stringify(raw)]
  );
  return family;
}

async function addParent({ phone, sourceId, lineUid = null, student = null }) {
  const parent = (await pool.query(
    `INSERT INTO parents(phone,name,line_uid,ragic_record_id,is_active)
     VALUES ($1,'既有家長',$2,$3,TRUE) RETURNING *`, [phone, lineUid, sourceId]
  )).rows[0];
  parentIds.push(parent.id);
  let child = null;
  if (student) {
    child = (await pool.query(
      `INSERT INTO students(parent_id,name,birth_date,gender,id_number,blood_type,is_active,last_synced_at)
       VALUES ($1,$2,$3::date,$4,$5,$6,TRUE,NOW()) RETURNING *`,
      [parent.id, student.name, student.birth_date || '2014-01-02', student.gender || '生理女',
       student.id_number || 'A123456789', student.blood_type || '不清楚']
    )).rows[0];
  }
  return { parent, student: child };
}

function newStudent(name, id = 'A123456789') {
  return { name, id_number: id, birth_date: '2014-01-02', gender: '生理女', blood_type: '不清楚' };
}

async function cleanup() {
  const sources = [...new Set(sourceIds)];
  const claims = sources.length ? (await pool.query(
    `SELECT id,canonical_parent_id,correlation_id FROM identity_claims WHERE source_record_id=ANY($1::text[])`, [sources]
  )).rows : [];
  const claimIds = claims.map((row) => row.id);
  for (const row of claims) {
    if (row.canonical_parent_id) parentIds.push(row.canonical_parent_id);
    if (row.correlation_id) correlationIds.push(row.correlation_id);
  }
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
  }
  if (sources.length) {
    await pool.query(`DELETE FROM parent_profile_patch_audit WHERE source_record_id=ANY($1::text[])`, [sources]);
    await pool.query(`DELETE FROM parent_identity_backoffice_tasks WHERE source_record_ids && $1::text[]`, [sources]);
    await pool.query(`DELETE FROM source_record_links WHERE source_record_id=ANY($1::text[])`, [sources]);
  }
  if (claimIds.length) await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  if (sources.length) {
    await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id=ANY($1::text[])`, [sources]);
    await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id=ANY($1::text[])`, [sources]);
  }
  for (const parentId of [...new Set(parentIds.filter(Boolean))]) {
    await pool.query(`DELETE FROM parent_identity_backoffice_tasks WHERE canonical_parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parent_profile_patch_audit WHERE canonical_parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
}

async function T26() {
  const phone = phoneFor(6);
  const sourceId = `ZZT26${suffix}`;
  const lineUid = uid('T26');
  await addFamily({ sourceId, phone });
  const { parent } = await addParent({ phone, sourceId });
  const beforeParents = (await pool.query(`SELECT COUNT(*)::int n FROM parents WHERE phone=$1`, [phone])).rows[0].n;
  const result = await claimZ03Identity({
    phone, studentName: '零學員新增', studentInput: newStudent('零學員新增'), lineUid,
    parentProfile: { name: '表單家長', phone, email: 'zero@example.com' },
    allowStudentAppend: true, ownershipVerified: true,
  });
  assert.strictEqual(result.parent.id, parent.id);
  assert.strictEqual(result.student_appended, true);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM parents WHERE phone=$1`, [phone])).rows[0].n, beforeParents);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM students WHERE parent_id=$1`, [parent.id])).rows[0].n, 1);
  const job = (await pool.query(`SELECT * FROM ragic_sync_outbox WHERE target_record_id=$1`, [sourceId])).rows[0];
  assert.ok(job);
  assert.strictEqual(job.operation, 'BIND_Z01_LINE_UID');
  assert.strictEqual(job.payload_reference.students_to_append.length, 1);
  assert.strictEqual(job.payload_reference.profile_patch['1006846'], lineUid);

  // HTTP registration proof: a local shadow/Z03 zero-student legacy source
  // authenticates immediately and performs no synchronous Ragic call.
  const routePhone = `0966${suffix}`;
  const routeSource = `ZZT26R${suffix}`;
  const routeUid = uid('T26R');
  await addFamily({ sourceId: routeSource, phone: routePhone });
  const routeParent = await addParent({ phone: routePhone, sourceId: routeSource });
  const venue = (await pool.query(`SELECT id FROM venues WHERE is_active=TRUE ORDER BY id LIMIT 1`)).rows[0];
  assert.ok(venue, 'active venue fixture required');
  const originalAxiosPost = axios.post;
  const originalRagic = {};
  let ragicCalls = 0;
  for (const name of ['getParentByPhone','getParentByLineUid','createParentWithStudentsInRagic']) {
    originalRagic[name] = ragic[name];
    ragic[name] = async () => { ragicCalls += 1; throw new Error('unexpected synchronous Ragic call'); };
  }
  axios.post = async () => ({ status: 200, data: { sub: routeUid, aud: 'closure-channel' } });
  process.env.LINE_LOGIN_CHANNEL_ID = 'closure-channel';
  process.env.PARENT_IDENTITY_RESOLVER_V2 = 'true';
  delete require.cache[require.resolve('../../server/services/lineAuth')];
  delete require.cache[require.resolve('../../server/routes/auth')];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../server/routes/auth'));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/parent-register-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id_token: 'closure-token',
        parent: { name: '路由家長', phone: routePhone, email: '', gender: '生理女', primary_venue_id: venue.id },
        students: [newStudent('路由新增學員', 'H123456789')],
      }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.status, 'registered_and_logged_in');
    assert.strictEqual(body.parent.id, routeParent.parent.id);
    assert.ok(body.token);
    assert.strictEqual(body.parent_state, 'SYNC_IN_PROGRESS');
    assert.strictEqual(ragicCalls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    axios.post = originalAxiosPost;
    Object.assign(ragic, originalRagic);
    delete process.env.PARENT_IDENTITY_RESOLVER_V2;
  }
}

async function T27() {
  const phone = phoneFor(7);
  const sourceId = `ZZT27${suffix}`;
  const lineUid = uid('T27');
  const first = newStudent('第一位學員', 'B123456789');
  await addFamily({ sourceId, phone, student: first });
  const fixture = await addParent({ phone, sourceId, student: first });
  await pool.query(
    `INSERT INTO source_record_links
       (source_system,source_table,source_record_id,canonical_parent_id,canonical_student_id,link_method)
     VALUES ('RAGIC','Z01',$1,$2,$3,'EXISTING_SOURCE')`,
    [sourceId, fixture.parent.id, fixture.student.id]
  );
  const beforeFirst = (await pool.query(`SELECT * FROM students WHERE id=$1`, [fixture.student.id])).rows[0];
  const second = newStudent('第二位學員', 'C123456789');
  const result = await claimZ03Identity({
    phone, studentName: second.name, studentInput: second, lineUid,
    parentProfile: { name: '既有家長', phone }, allowStudentAppend: true, ownershipVerified: true,
  });
  assert.strictEqual(result.parent.id, fixture.parent.id);
  const students = (await pool.query(`SELECT * FROM students WHERE parent_id=$1 ORDER BY created_at,id`, [fixture.parent.id])).rows;
  assert.strictEqual(students.length, 2);
  assert.strictEqual(students[0].id, beforeFirst.id);
  assert.strictEqual(students[0].name, beforeFirst.name);
  assert.ok(students.some((row) => row.name === second.name));
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM parents WHERE phone=$1`, [phone])).rows[0].n, 1);
  const link = (await pool.query(`SELECT * FROM source_record_links WHERE source_record_id=$1`, [sourceId])).rows[0];
  assert.strictEqual(link.canonical_student_id, fixture.student.id);
}

async function T28() {
  const phone = phoneFor(8);
  const sourceId = `ZZT28A${suffix}`;
  const lineUid = uid('T28');
  const child = newStudent('Email 學員', 'D123456789');
  await addFamily({ sourceId, phone, email: '', student: child });
  const result = await claimZ03Identity({
    phone, studentName: child.name, studentInput: child, lineUid,
    parentProfile: { name: '舊家長', phone, email: 'parent@example.com' },
    allowStudentAppend: true, ownershipVerified: true,
  });
  parentIds.push(result.parent.id);
  const job = (await pool.query(`SELECT * FROM ragic_sync_outbox WHERE target_record_id=$1`, [sourceId])).rows[0];
  assert.strictEqual(job.payload_reference.profile_patch['1002820'], 'parent@example.com');
  assert.strictEqual(job.payload_reference.profile_patch['1006846'], lineUid);
  const remote = { _ragicId: sourceId, 1006846: '', 1002820: '' };
  const writes = [];
  const processed = await processRagicSyncOutbox({
    idempotencyKey: job.idempotency_key,
    schemaGuard: async () => true,
    reader: async () => ({ ...remote }),
    writer: async (payload, recordId) => { assert.strictEqual(recordId, sourceId); writes.push(payload); Object.assign(remote, payload); },
  });
  assert.strictEqual(processed.synced, 1);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(remote['1006846'], lineUid);
  assert.strictEqual(remote['1002820'], 'parent@example.com');

  const blockedSource = `ZZT28B${suffix}`;
  const blockedPhone = phoneFor(9);
  const blockedUid = uid('T28B');
  await addFamily({ sourceId: blockedSource, phone: blockedPhone, student: newStudent('拒絕學員', 'E123456789') });
  const blocked = await claimZ03Identity({
    phone: blockedPhone, studentName: '拒絕學員', studentInput: newStudent('拒絕學員', 'E123456789'),
    lineUid: blockedUid, parentProfile: { name: '拒絕家長', phone: blockedPhone },
    allowStudentAppend: true, ownershipVerified: true,
  });
  parentIds.push(blocked.parent.id);
  const blockedJob = (await pool.query(`SELECT * FROM ragic_sync_outbox WHERE target_record_id=$1`, [blockedSource])).rows[0];
  await processRagicSyncOutbox({
    idempotencyKey: blockedJob.idempotency_key,
    schemaGuard: async () => true,
    reader: async () => ({ _ragicId: blockedSource, 1006846: '' }),
    writer: async () => { const err = new Error('required field'); err.code = 'RAGIC_VALIDATION_ERROR'; throw err; },
  });
  const blockedState = (await pool.query(`SELECT state FROM ragic_sync_outbox WHERE id=$1`, [blockedJob.id])).rows[0].state;
  assert.strictEqual(blockedState, 'blocked_schema');
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM parents WHERE id=$1 AND line_uid=$2`, [blocked.parent.id, blockedUid])).rows[0].n, 1);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM ragic_sync_outbox WHERE source_record_id=$1 AND operation='CREATE_Z01_PARENT'`, [blockedSource])).rows[0].n, 0);
}

async function T29() {
  const sourceId = `ZZT29${suffix}`;
  sourceIds.push(sourceId);
  const raw = { _ragicId: sourceId, 1006846: '', 1001100: '身份證誤貼123456789', 1001101: '錯置電話來源' };
  const preview = await ragicAdmin.reingestZ01Record(raw, { dryRun: true });
  assert.strictEqual(preview.target, 'MANUAL_REVIEW');
  assert.strictEqual(preview.reason_code, 'INVALID_CANONICAL_PHONE');
  await ragicAdmin.reingestZ01Record(raw, { dryRun: false });
  const z03 = (await pool.query(`SELECT status,reason_code FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [sourceId])).rows[0];
  assert.deepStrictEqual(z03, { status: 'manual_review', reason_code: 'INVALID_CANONICAL_PHONE' });
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int n FROM parent_identity_backoffice_tasks WHERE source_record_ids && ARRAY[$1]::text[]`,
    [sourceId]
  )).rows[0].n, 1);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM source_record_links WHERE source_record_id=$1`, [sourceId])).rows[0].n, 0);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM ragic_sync_outbox WHERE source_record_id=$1`, [sourceId])).rows[0].n, 0);
}

async function T30() {
  const phone = phoneFor(0);
  const sourceId = `ZZT30${suffix}`;
  const lineUid = uid('T30');
  const child = newStudent('團班舊生', 'F123456789');
  await addFamily({ sourceId, phone, student: child, rawName: '團班歷史家長' });
  const before = await rightsSnapshot();
  const result = await claimZ03Identity({
    phone, studentName: child.name, studentInput: child, lineUid,
    parentProfile: { name: '團班歷史家長', phone }, allowStudentAppend: true, ownershipVerified: true,
  });
  parentIds.push(result.parent.id);
  const after = await rightsSnapshot();
  assert.strictEqual(after.hash, before.hash);
  assert.strictEqual(result.parent.ragic_record_id, sourceId);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM source_record_links WHERE source_record_id=$1 AND canonical_parent_id=$2`, [sourceId, result.parent.id])).rows[0].n, 1);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM ragic_sync_outbox WHERE target_record_id=$1 AND field_id='1006846'`, [sourceId])).rows[0].n, 1);
}

async function T31() {
  assert.strictEqual(
    ragic.mapZ01Parent({ '家教系統uid': 'U_FORBIDDEN_FALLBACK' }).line_uid,
    '',
    'LINE UID must never use the Chinese display-name fallback'
  );
  const phone = `0971${suffix}`;
  const sourceId = `ZZT31${suffix}`;
  const lineUid = uid('T31');
  const child = newStudent('權益學員', 'G123456789');
  await addFamily({ sourceId, phone, email: '', student: child });
  const before = await rightsSnapshot();
  const result = await claimZ03Identity({
    phone, studentName: child.name, studentInput: child, lineUid,
    parentProfile: { name: '權益家長', phone, email: 'rights@example.com', home_address: '聯絡地址' },
    allowStudentAppend: true, ownershipVerified: true,
  });
  parentIds.push(result.parent.id);
  const job = (await pool.query(`SELECT payload_reference FROM ragic_sync_outbox WHERE target_record_id=$1`, [sourceId])).rows[0];
  const patchKeys = Object.keys(job.payload_reference.profile_patch);
  assert.ok(patchKeys.length >= 2);
  assert.ok(patchKeys.every((fieldId) => PROFILE_PATCH_ALLOWLIST.has(fieldId)));
  for (const forbidden of ['身分證字號','學員編號','訂單','付款','退款','剩餘堂數','簽到','扣堂']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(job.payload_reference.profile_patch, forbidden), false);
  }
  const after = await rightsSnapshot();
  assert.strictEqual(after.hash, before.hash);
  console.log(`T31_RIGHTS before=${before.hash} after=${after.hash} counts=${JSON.stringify(after.counts)}`);
}

const CASES = { T26, T27, T28, T29, T30, T31 };

(async () => {
  if (!CASES[testId]) throw new Error(`unknown test id: ${testId}`);
  await cleanup();
  try {
    await CASES[testId]();
    console.log(`${testId}: PASS`);
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
