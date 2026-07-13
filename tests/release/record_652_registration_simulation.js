'use strict';

const assert = require('assert');
const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');
const ragicAdmin = require('../../server/services/ragicAdmin');

const sourceId = `ZZSIM652${Date.now()}`;
const phone = `0965${String(Date.now()).slice(-6)}`;
const lineUid = `USIM652${crypto.randomBytes(12).toString('hex')}`;
const studentName = 'Record652模擬學員';

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function rightsHash() {
  const rows = {};
  for (const [key, sql] of Object.entries({
    orders: `SELECT id,leader_parent_id,status,period_count,roster_approved FROM group_orders ORDER BY id`,
    order_members: `SELECT id,group_order_id,parent_id,student_ids,status FROM group_order_members ORDER BY id`,
    enrollments: `SELECT id,parent_phone,status,total_sessions,used_sessions,final_price,refund_amount,group_order_id
                    FROM admin_enrollments ORDER BY id`,
    lessons: `SELECT id,total_sessions,used_sessions,status,admin_enrollment_id,group_order_id
                FROM course_periods ORDER BY id`,
    attendance: `SELECT id,course_session_id,student_id,is_auto_linked,checked_in_at,checked_in_source
                   FROM checkin_records ORDER BY id`,
  })) rows[key] = (await pool.query(sql)).rows;
  return hash(rows);
}

async function cleanup() {
  const claims = (await pool.query(
    `SELECT id,canonical_parent_id FROM identity_claims WHERE source_record_id=$1`, [sourceId]
  )).rows;
  const claimIds = claims.map((row) => row.id);
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
  }
  await pool.query(`DELETE FROM parent_profile_patch_audit WHERE source_record_id=$1`, [sourceId]);
  await pool.query(`DELETE FROM parent_identity_backoffice_tasks WHERE source_record_ids && ARRAY[$1]::text[]`, [sourceId]);
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id=$1`, [sourceId]);
  if (claimIds.length) await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [sourceId]);
  await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id=$1`, [sourceId]);
  for (const parentId of claims.map((row) => row.canonical_parent_id).filter(Boolean)) {
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
}

(async () => {
  await cleanup();
  const realBefore = (await pool.query(
    `SELECT s.raw_data,z.status,z.classification,z.claim_state
       FROM ragic_z01_shadow s LEFT JOIN ragic_z03_records z ON z.z01_ragic_record_id=s.ragic_record_id
      WHERE s.ragic_record_id='652'`
  )).rows[0];
  assert.ok(realBefore, 'live shadow record 652 must exist');
  const realBeforeHash = hash(realBefore);
  const rightsBefore = await rightsHash();

  const clone = JSON.parse(JSON.stringify(realBefore.raw_data));
  clone._ragicId = sourceId;
  clone['1001100'] = phone;
  clone['1001101'] = 'Record652模擬家長';
  clone['1002820'] = '';
  clone['1006846'] = '';
  const subtable = clone._subtable_1001119 || clone['1001119'];
  assert.ok(subtable && typeof subtable === 'object', 'record 652 student subtable shape required');
  for (const row of Object.values(subtable)) {
    row['1001115'] = studentName;
    row['1001118'] = 'A123456789';
    row['1001132'] = 'SIM652001';
    row['1004090'] = phone;
  }
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
     VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`, [sourceId, JSON.stringify(clone)]
  );
  await ragicAdmin.hydrateZ03RecordFromRagicRow(clone);

  const venue = (await pool.query(`SELECT id FROM venues WHERE is_active=TRUE ORDER BY id LIMIT 1`)).rows[0];
  assert.ok(venue);
  const originalAxiosPost = axios.post;
  const originalRagic = {};
  let synchronousRagicCalls = 0;
  for (const name of ['getParentByPhone', 'getParentByLineUid', 'createParentWithStudentsInRagic']) {
    originalRagic[name] = ragic[name];
    ragic[name] = async () => {
      synchronousRagicCalls += 1;
      throw new Error(`unexpected synchronous Ragic call: ${name}`);
    };
  }
  axios.post = async () => ({ status: 200, data: { sub: lineUid, aud: 'record-652-sim-channel' } });
  process.env.LINE_LOGIN_CHANNEL_ID = 'record-652-sim-channel';
  process.env.PARENT_IDENTITY_RESOLVER_V2 = 'true';
  process.env.PARENT_LOCAL_FIRST = 'true';
  process.env.RAGIC_PARENT_OUTBOX = 'true';
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
        id_token: 'record-652-sim-token',
        parent: {
          name: 'Record652模擬家長', phone, email: 'record652.sim@gmail.com',
          gender: '生理女', primary_venue_id: venue.id,
        },
        students: [{
          name: studentName, id_number: 'A123456789', birth_date: '2019-10-14',
          gender: '生理男', blood_type: '不清楚',
        }],
      }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.status, 'registered_and_logged_in');
    assert.ok(body.token);
    assert.strictEqual(body.parent_state, 'SYNC_IN_PROGRESS');
    assert.strictEqual(synchronousRagicCalls, 0);
    const localParent = (await pool.query(`SELECT * FROM parents WHERE id=$1`, [body.parent.id])).rows[0];
    assert.strictEqual(localParent.ragic_record_id, sourceId);
    const parentCount = (await pool.query(`SELECT COUNT(*)::int n FROM parents WHERE phone=$1`, [phone])).rows[0].n;
    const studentCount = (await pool.query(
      `SELECT COUNT(*)::int n FROM students WHERE parent_id=$1`, [body.parent.id]
    )).rows[0].n;
    const outbox = (await pool.query(
      `SELECT operation,target_record_id,payload_reference FROM ragic_sync_outbox WHERE source_record_id=$1`, [sourceId]
    )).rows[0];
    assert.strictEqual(parentCount, 1);
    assert.strictEqual(studentCount, 1);
    assert.strictEqual(outbox.operation, 'BIND_Z01_LINE_UID');
    assert.strictEqual(outbox.target_record_id, sourceId);
    assert.strictEqual(outbox.payload_reference.profile_patch['1006846'], lineUid);
    assert.strictEqual(outbox.payload_reference.profile_patch['1002820'], 'record652.sim@gmail.com');
    assert.strictEqual((outbox.payload_reference.students_to_append || []).length, 0);
    assert.strictEqual(await rightsHash(), rightsBefore);
    console.log(JSON.stringify({
      test: 'Record 652 structural registration-to-login simulation',
      result: 'PASS',
      source_shape: 'LIVE_652_ANONYMIZED_TEMP_CLONE',
      http_status: response.status,
      login_status: body.status,
      parent_state: body.parent_state,
      synchronous_ragic_calls: synchronousRagicCalls,
      parent_count: parentCount,
      student_count: studentCount,
      outbox_operation: outbox.operation,
      uid_field: '1006846',
      email_field: '1002820',
      student_append_count: 0,
      rights_hash_unchanged: true,
    }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    axios.post = originalAxiosPost;
    Object.assign(ragic, originalRagic);
    delete process.env.PARENT_IDENTITY_RESOLVER_V2;
    await cleanup();
  }

  const realAfter = (await pool.query(
    `SELECT s.raw_data,z.status,z.classification,z.claim_state
       FROM ragic_z01_shadow s LEFT JOIN ragic_z03_records z ON z.z01_ragic_record_id=s.ragic_record_id
      WHERE s.ragic_record_id='652'`
  )).rows[0];
  assert.strictEqual(hash(realAfter), realBeforeHash, 'real record 652 must remain unchanged');
  assert.strictEqual(await rightsHash(), rightsBefore);
  console.log('record_652_real_source_unchanged: PASS');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await cleanup(); } catch {}
  await pool.end();
});
