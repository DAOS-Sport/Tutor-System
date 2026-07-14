'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');

const suffix = String(Date.now()).slice(-6);
const sourceId = `ZZDUPNAME${suffix}`;
const phone = `0937${suffix}`;
const lineUid = `U${crypto.randomBytes(16).toString('hex')}`;
const studentName = '附件同名學員';
const successSourceId = `ZZDISTINCT${suffix}`;
const successPhone = `0936${suffix}`;
const successLineUid = `U${crypto.randomBytes(16).toString('hex')}`;

async function cleanup() {
  const sourceIds = [sourceId, successSourceId];
  const claims = (await pool.query(
    `SELECT id,canonical_parent_id FROM identity_claims WHERE source_record_id=ANY($1::text[])`, [sourceIds]
  )).rows;
  const claimIds = claims.map((row) => row.id);
  const parentIds = claims.map((row) => row.canonical_parent_id).filter(Boolean);
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
  }
  await pool.query(`DELETE FROM parent_identity_backoffice_tasks WHERE source_record_ids && $1::text[]`, [sourceIds]);
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

async function postJson(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/parent-bind-phone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

(async () => {
  await cleanup();
  const originalAxiosPost = axios.post;
  const originalRagic = {};
  let synchronousRagicCalls = 0;
  let server;
  try {
    const family = (await pool.query(
      `INSERT INTO ragic_z03_records
         (z01_ragic_record_id,raw_name,phone,phone_canonical,status,classification,reason_code,
          claim_state,last_error_code)
       VALUES ($1,'附件模擬家長',$2,$2,'manual_review','MANUAL_REVIEW','AMBIGUOUS_STUDENT_MATCH',
               'MANUAL_REVIEW','AMBIGUOUS_STUDENT_MATCH')
       RETURNING id`, [sourceId, phone]
    )).rows[0];
    await pool.query(
      `INSERT INTO ragic_z03_students
         (z03_record_id,name_raw,name_normalized,source_row_key,classification,present_in_latest_payload)
       VALUES
         ($1,$2,$3,'row-1','VALID',TRUE),
         ($1,$4,$3,'row-2','VALID',TRUE)`,
      [family.id, studentName, studentName, `附 件 同名學員`]
    );
    const successFamily = (await pool.query(
      `INSERT INTO ragic_z03_records
         (z01_ragic_record_id,raw_name,phone,phone_canonical,status,classification,reason_code,claim_state)
       VALUES ($1,'不同姓名家長',$2,$2,'pending','PENDING_Z03','TRUE_LINE_UID_EMPTY','UNRESOLVED')
       RETURNING id`, [successSourceId, successPhone]
    )).rows[0];
    await pool.query(
      `INSERT INTO ragic_z03_students
         (z03_record_id,name_raw,name_normalized,source_row_key,classification,present_in_latest_payload)
       VALUES
         ($1,'不同學員甲','不同學員甲','row-1','VALID',TRUE),
         ($1,'不同學員乙','不同學員乙','row-2','VALID',TRUE)`,
      [successFamily.id]
    );
    await pool.query(
      `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
       VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`,
      [successSourceId, JSON.stringify({
        _ragicId: successSourceId,
        1001101: '不同姓名家長',
        1001100: successPhone,
        1006846: '',
        _subtable_1001119: {
          'row-1': { 1001115: '不同學員甲', 1004090: successPhone },
          'row-2': { 1001115: '不同學員乙', 1004090: successPhone },
        },
      })]
    );
    await pool.query(
      `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
       VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`,
      [sourceId, JSON.stringify({
        _ragicId: sourceId,
        1001101: '附件模擬家長',
        1001100: phone,
        1006846: '',
        _subtable_1001119: {
          'row-1': { 1001115: studentName, 1004090: phone },
          'row-2': { 1001115: '附 件 同名學員', 1004090: phone },
        },
      })]
    );

    for (const name of ['getParentByPhone', 'getParentByLineUid', 'createParentWithStudentsInRagic']) {
      originalRagic[name] = ragic[name];
      ragic[name] = async () => {
        synchronousRagicCalls++;
        throw new Error(`unexpected Ragic call: ${name}`);
      };
    }
    let currentUid = successLineUid;
    axios.post = async () => ({ status: 200, data: { sub: currentUid, aud: 'duplicate-name-channel' } });
    process.env.LINE_LOGIN_CHANNEL_ID = 'duplicate-name-channel';
    process.env.PARENT_IDENTITY_RESOLVER_V2 = 'true';
    process.env.PARENT_LOCAL_FIRST = 'true';
    delete require.cache[require.resolve('../../server/services/lineAuth')];
    delete require.cache[require.resolve('../../server/routes/auth')];
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../../server/routes/auth'));
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const distinctFirst = await postJson(server.address().port, {
      id_token: 'distinct-name-first-step', phone: successPhone,
    });
    assert.strictEqual(distinctFirst.response.status, 200);
    assert.strictEqual(distinctFirst.body.status, 'need_claim_verification');
    const distinctSecond = await postJson(server.address().port, {
      id_token: 'distinct-name-claim-step',
      phone: successPhone,
      claim: { student_name: '不同學員甲', phone: successPhone, parent_name: '不同姓名家長' },
    });
    assert.strictEqual(distinctSecond.response.status, 200, JSON.stringify(distinctSecond.body));
    assert.strictEqual(distinctSecond.body.status, 'bound_and_logged_in');
    assert.ok(distinctSecond.body.token);
    assert.strictEqual((await pool.query(
      `SELECT COUNT(*)::int AS count FROM ragic_sync_outbox WHERE source_record_id=$1`,
      [successSourceId]
    )).rows[0].count, 1);

    currentUid = lineUid;

    const first = await postJson(server.address().port, {
      id_token: 'duplicate-name-first-step', phone,
    });
    assert.strictEqual(first.response.status, 200);
    assert.deepStrictEqual(first.body, {
      status: 'need_claim_verification', phone, reason: 'local_z03_pending',
    });

    const second = await postJson(server.address().port, {
      id_token: 'duplicate-name-claim-step',
      phone,
      claim: { student_name: studentName, phone, parent_name: '附件模擬家長' },
    });
    assert.strictEqual(second.response.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body.status, 'bound_and_logged_in');
    assert.strictEqual(second.body.sync_state, 'SYNC_PENDING');
    assert.ok(second.body.token);
    assert.strictEqual(synchronousRagicCalls, 0);

    const state = (await pool.query(
      `SELECT status,classification,claim_state,reason_code,last_error_code
         FROM ragic_z03_records WHERE id=$1`, [family.id]
    )).rows[0];
    assert.deepStrictEqual(state, {
      status: 'resolved',
      classification: 'RESOLVED',
      claim_state: 'SYNC_PENDING',
      reason_code: 'CLAIM_LINKED_LOCAL',
      last_error_code: null,
    });
    const counts = (await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM parents WHERE phone=$1) AS parents,
        (SELECT COUNT(*)::int FROM source_record_links WHERE source_record_id=$2) AS links,
        (SELECT COUNT(*)::int FROM ragic_sync_outbox WHERE source_record_id=$2) AS outbox,
        (SELECT COUNT(DISTINCT canonical_student_id)::int FROM ragic_z03_students
          WHERE z03_record_id=$3 AND canonical_student_id IS NOT NULL) AS canonical_students,
        (SELECT COUNT(*)::int FROM ragic_z03_students
          WHERE z03_record_id=$3 AND canonical_student_id IS NOT NULL) AS linked_source_rows`,
      [phone, sourceId, family.id]
    )).rows[0];
    assert.deepStrictEqual(counts, {
      parents: 1,
      links: 1,
      outbox: 1,
      canonical_students: 1,
      linked_source_rows: 2,
    });
    console.log('z03_same_source_duplicate_student_bind_test: PASS distinct-name and same-source duplicate-name login/bind; no synchronous Ragic write');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    axios.post = originalAxiosPost;
    Object.assign(ragic, originalRagic);
    delete process.env.PARENT_IDENTITY_RESOLVER_V2;
    delete process.env.PARENT_LOCAL_FIRST;
    await cleanup();
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
