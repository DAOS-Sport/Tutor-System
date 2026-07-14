'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');
const ragicAdmin = require('../../server/services/ragicAdmin');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');

const BATCH_SIZE = 50;
const runId = `${Date.now()}${process.pid}`;
const fixtures = Array.from({ length: BATCH_SIZE }, (_, index) => {
  const studentCount = index < 10 ? 0 : (index < 30 ? 1 : (index < 45 ? 2 : 3));
  const phoneTail = String((Number(runId.slice(-7)) + index) % 10_000_000).padStart(7, '0');
  return {
    index,
    sourceId: `ZZFORM50${runId}${String(index).padStart(2, '0')}`,
    phone: `094${phoneTail}`,
    lineUid: `U${crypto.createHash('sha256').update(`${runId}:${index}`).digest('hex').slice(0, 32)}`,
    parentName: `批次匿名家長${String(index).padStart(2, '0')}`,
    email: `form50.${runId}.${index}@example.invalid`,
    studentCount,
    selectedStudent: studentCount === 0
      ? `批次新增學員${String(index).padStart(2, '0')}`
      : `批次既有學員${String(index).padStart(2, '0')}-1`,
    existingParentId: null,
    resultParentId: null,
  };
});

function studentRow(fixture, rowIndex) {
  return {
    1001115: `批次既有學員${String(fixture.index).padStart(2, '0')}-${rowIndex + 1}`,
    1001116: `201${rowIndex + 4}/0${(rowIndex % 8) + 1}/1${rowIndex}`,
    1001117: rowIndex % 2 ? '生理女' : '生理男',
    1001118: rowIndex === 0 ? 'A123456789' : '',
    1001132: `SIM50-${fixture.index}-${rowIndex + 1}`,
    1004090: fixture.phone,
  };
}

function sourceRow(fixture) {
  const subtable = {};
  for (let i = 0; i < fixture.studentCount; i++) subtable[`row-${i + 1}`] = studentRow(fixture, i);
  return {
    _ragicId: fixture.sourceId,
    1001101: fixture.parentName,
    1001100: fixture.phone,
    1002820: '',
    1006846: '',
    1002174: '',
    1002390: 'https://example.invalid/anonymized-chat',
    109: '2026/07/14 12:00:00',
    _subtable_1001119: subtable,
  };
}

async function rightsHash() {
  const snapshot = {};
  for (const [name, sql] of Object.entries({
    orders: `SELECT id,leader_parent_id,status,period_count,roster_approved FROM group_orders ORDER BY id`,
    order_members: `SELECT id,group_order_id,parent_id,student_ids,status FROM group_order_members ORDER BY id`,
    enrollments: `SELECT id,parent_phone,status,total_sessions,used_sessions,final_price,refund_amount,group_order_id FROM admin_enrollments ORDER BY id`,
    lessons: `SELECT id,total_sessions,used_sessions,status,admin_enrollment_id,group_order_id FROM course_periods ORDER BY id`,
    attendance: `SELECT id,course_session_id,student_id,is_auto_linked,checked_in_at,checked_in_source FROM checkin_records ORDER BY id`,
  })) snapshot[name] = (await pool.query(sql)).rows;
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

async function cleanup() {
  const sourceIds = fixtures.map((fixture) => fixture.sourceId);
  const phones = fixtures.map((fixture) => fixture.phone);
  const claims = (await pool.query(
    `SELECT id,canonical_parent_id FROM identity_claims WHERE source_record_id=ANY($1::text[])`, [sourceIds]
  )).rows;
  const claimIds = claims.map((row) => row.id);
  const parentRows = (await pool.query(
    `SELECT id FROM parents WHERE phone=ANY($1::text[]) OR id=ANY($2::uuid[])`,
    [phones, claims.map((row) => row.canonical_parent_id).filter(Boolean)]
  )).rows;
  const parentIds = [...new Set(parentRows.map((row) => row.id))];
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
  }
  await pool.query(`DELETE FROM parent_identity_backoffice_tasks WHERE source_record_ids && $1::text[]`, [sourceIds]);
  await pool.query(`DELETE FROM parent_profile_patch_audit WHERE source_record_id=ANY($1::text[])`, [sourceIds]);
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id=ANY($1::text[])`, [sourceIds]);
  if (claimIds.length) await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id=ANY($1::text[])`, [sourceIds]);
  await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id=ANY($1::text[])`, [sourceIds]);
  if (parentIds.length) {
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=ANY($1::uuid[])`, [parentIds]);
    await pool.query(`DELETE FROM students WHERE parent_id=ANY($1::uuid[])`, [parentIds]);
    await pool.query(`DELETE FROM parents WHERE id=ANY($1::uuid[])`, [parentIds]);
  }
}

async function postJson(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

(async () => {
  const initialNonSynced = Number((await pool.query(
    `SELECT COUNT(*)::int AS count FROM ragic_sync_outbox WHERE state<>'synced'`
  )).rows[0].count);
  assert.strictEqual(initialNonSynced, 0, 'batch simulation requires an empty non-synced local outbox');
  await cleanup();
  const rightsBefore = await rightsHash();
  const venue = (await pool.query(`SELECT id FROM venues WHERE is_active=TRUE ORDER BY id LIMIT 1`)).rows[0];
  assert.ok(venue, 'active venue fixture required');

  const originalAxiosPost = axios.post;
  const originalRagic = {};
  let currentUid = null;
  let synchronousRagicCalls = 0;
  let server;
  for (const name of ['getParentByPhone', 'getParentByLineUid', 'createParentWithStudentsInRagic']) {
    originalRagic[name] = ragic[name];
    ragic[name] = async () => {
      synchronousRagicCalls++;
      throw new Error(`unexpected synchronous Ragic call: ${name}`);
    };
  }
  axios.post = async () => ({ status: 200, data: { sub: currentUid, aud: 'form50-channel' } });
  process.env.LINE_LOGIN_CHANNEL_ID = 'form50-channel';
  process.env.PARENT_IDENTITY_RESOLVER_V2 = 'true';
  process.env.PARENT_LOCAL_FIRST = 'true';
  process.env.RAGIC_PARENT_OUTBOX = 'true';

  try {
    for (const fixture of fixtures) {
      const raw = sourceRow(fixture);
      await pool.query(
        `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
         VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`,
        [fixture.sourceId, JSON.stringify(raw)]
      );
      await ragicAdmin.hydrateZ03RecordFromRagicRow(raw);
      if (fixture.studentCount === 0) {
        fixture.existingParentId = (await pool.query(
          `INSERT INTO parents(phone,name,ragic_record_id,is_active)
           VALUES ($1,$2,$3,TRUE) RETURNING id`,
          [fixture.phone, fixture.parentName, fixture.sourceId]
        )).rows[0].id;
      }
    }

    delete require.cache[require.resolve('../../server/services/lineAuth')];
    delete require.cache[require.resolve('../../server/routes/auth')];
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../../server/routes/auth'));
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const registrationResults = [];
    for (const fixture of fixtures) {
      currentUid = fixture.lineUid;
      const response = await postJson(server.address().port, '/api/auth/parent-register-line', {
        id_token: `form50-register-${fixture.index}`,
        parent: {
          name: fixture.parentName,
          phone: fixture.phone,
          email: fixture.email,
          gender: fixture.index % 2 ? '生理女' : '生理男',
          primary_venue_id: venue.id,
        },
        students: [{
          name: fixture.selectedStudent,
          id_number: 'A123456789',
          birth_date: '2018-03-04',
          gender: fixture.index % 2 ? '生理女' : '生理男',
          blood_type: '不清楚',
        }],
      });
      const body = await response.json();
      registrationResults.push({ fixture, response, body });
      assert.strictEqual(response.status, 200, `fixture ${fixture.index}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.status, 'registered_and_logged_in');
      assert.strictEqual(body.parent_state, 'SYNC_IN_PROGRESS');
      assert.ok(body.token);
      fixture.resultParentId = body.parent.id;
      if (fixture.existingParentId) assert.strictEqual(body.parent.id, fixture.existingParentId);
    }
    assert.strictEqual(synchronousRagicCalls, 0);

    const sourceIds = fixtures.map((fixture) => fixture.sourceId);
    const parentIds = fixtures.map((fixture) => fixture.resultParentId);
    assert.strictEqual(new Set(parentIds).size, BATCH_SIZE, 'each source must map to one distinct parent');
    const aggregate = (await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM parents WHERE id=ANY($1::uuid[])) AS parents,
        (SELECT COUNT(*)::int FROM students WHERE parent_id=ANY($1::uuid[])) AS students,
        (SELECT COUNT(*)::int FROM source_record_links WHERE source_record_id=ANY($2::text[])) AS links,
        (SELECT COUNT(*)::int FROM ragic_sync_outbox WHERE source_record_id=ANY($2::text[])) AS outbox,
        (SELECT COUNT(*)::int FROM ragic_z03_records WHERE z01_ragic_record_id=ANY($2::text[]) AND status='resolved') AS resolved`,
      [parentIds, sourceIds]
    )).rows[0];
    assert.deepStrictEqual(aggregate, { parents: 50, students: 50, links: 50, outbox: 50, resolved: 50 });

    const jobs = (await pool.query(
      `SELECT * FROM ragic_sync_outbox WHERE source_record_id=ANY($1::text[]) ORDER BY source_record_id`,
      [sourceIds]
    )).rows;
    assert.strictEqual(jobs.length, BATCH_SIZE);
    let expectedStudentAppends = 0;
    for (const job of jobs) {
      const fixture = fixtures.find((item) => item.sourceId === job.source_record_id);
      assert.ok(fixture);
      assert.strictEqual(job.operation, 'BIND_Z01_LINE_UID');
      assert.strictEqual(job.target_record_id, fixture.sourceId);
      assert.strictEqual(job.field_id, '1006846');
      assert.strictEqual(job.state, 'pending');
      assert.strictEqual(job.attempts, 0);
      assert.strictEqual(job.payload_reference.profile_patch['1006846'], fixture.lineUid);
      assert.strictEqual(job.payload_reference.profile_patch['1002820'], fixture.email);
      const appendCount = (job.payload_reference.students_to_append || []).length;
      assert.strictEqual(appendCount, fixture.studentCount === 0 ? 1 : 0);
      expectedStudentAppends += appendCount;
    }

    for (const fixture of fixtures) {
      currentUid = fixture.lineUid;
      const response = await postJson(server.address().port, '/api/auth/parent-line-login', {
        id_token: `form50-pending-login-${fixture.index}`,
      });
      const body = await response.json();
      assert.strictEqual(response.status, 200, `pending login ${fixture.index}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.status, 'logged_in');
      assert.strictEqual(body.local_fast_path, true);
      assert.strictEqual(body.parent.id, fixture.resultParentId);
    }
    assert.strictEqual(synchronousRagicCalls, 0, 'pending registrations must login without Ragic');

    const remote = new Map(fixtures.map((fixture) => [fixture.sourceId, {
      _ragicId: fixture.sourceId, 1006846: '', 1002820: '',
    }]));
    const writtenNodes = new Set();
    const appendedNodes = new Set();
    let metadataOptInCount = 0;
    const processed = await processRagicSyncOutbox({
      limit: BATCH_SIZE,
      schemaGuard: async () => ({ verified: true }),
      reader: async (recordId) => ({ ...remote.get(String(recordId)) }),
      writer: async (patch, recordId, options) => {
        const node = String(recordId);
        assert.ok(remote.has(node));
        assert.strictEqual(writtenNodes.has(node), false, `duplicate parent write ${node}`);
        writtenNodes.add(node);
        if (options.includeResponseMetadata === true) metadataOptInCount++;
        Object.assign(remote.get(node), patch);
        return { data: { status: 'SUCCESS' }, responseMetadata: { httpStatus: 200 } };
      },
      studentWriter: async ({ parent, student }) => {
        const node = String(parent.ragic_record_id);
        assert.ok(remote.has(node));
        assert.strictEqual(appendedNodes.has(node), false, `duplicate student append ${node}`);
        appendedNodes.add(node);
        assert.ok(student?.name);
        return { z01: null, z02: { ragicRecordId: `Z02-${node}` }, parentRagicRecordId: node };
      },
    });
    assert.deepStrictEqual(processed, { processed: 50, synced: 50, retryable: 0, blocked: 0 });
    assert.strictEqual(writtenNodes.size, BATCH_SIZE);
    assert.strictEqual(appendedNodes.size, expectedStudentAppends);
    assert.strictEqual(metadataOptInCount, BATCH_SIZE);

    for (const fixture of fixtures) {
      const row = remote.get(fixture.sourceId);
      assert.strictEqual(row['1006846'], fixture.lineUid);
      assert.strictEqual(row['1002820'], fixture.email);
    }
    const finalJobs = (await pool.query(
      `SELECT state,attempts,last_error_code,sanitized_error,COUNT(*)::int AS count
         FROM ragic_sync_outbox WHERE source_record_id=ANY($1::text[])
        GROUP BY state,attempts,last_error_code,sanitized_error`, [sourceIds]
    )).rows;
    assert.deepStrictEqual(finalJobs, [{
      state: 'synced', attempts: 1, last_error_code: null, sanitized_error: null, count: 50,
    }]);
    assert.strictEqual(await rightsHash(), rightsBefore, 'registration/sync must not mutate rights tables');

    console.log(JSON.stringify({
      test: 'Z03 registration form 50-record batch simulation',
      result: 'PASS',
      fixtures: 50,
      shape: { zero_students: 10, one_student: 20, two_students: 15, three_students: 5 },
      registration_http_200: registrationResults.length,
      parents_created_or_reused: aggregate.parents,
      students_created: aggregate.students,
      source_links: aggregate.links,
      outbox_jobs: aggregate.outbox,
      pending_login_http_200: 50,
      synchronous_ragic_calls_during_registration_or_login: synchronousRagicCalls,
      ragic_parent_writes_http_200: writtenNodes.size,
      ragic_student_appends: appendedNodes.size,
      synced_jobs: finalJobs[0].count,
      retryable: 0,
      blocked: 0,
      rights_hash_unchanged: true,
    }, null, 2));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    axios.post = originalAxiosPost;
    Object.assign(ragic, originalRagic);
    delete process.env.PARENT_IDENTITY_RESOLVER_V2;
    delete process.env.PARENT_LOCAL_FIRST;
    delete process.env.RAGIC_PARENT_OUTBOX;
    await cleanup();
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
