'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');
const ragicAdmin = require('../../server/services/ragicAdmin');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');

const SAMPLE_SIZE = 10;
const ZERO_STUDENT_SAMPLES = 2;
const runId = `${Date.now()}${process.pid}`;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function anonymousPhone(index) {
  return `095${String((Number(runId.slice(-7)) + index) % 10_000_000).padStart(7, '0')}`;
}

function syntheticName(sampleIndex, nameIndex) {
  return `隨機抽樣學員${String(sampleIndex).padStart(2, '0')}-${nameIndex + 1}`;
}

async function selectSamples() {
  const selected = (await pool.query(
    `WITH counts AS (
       SELECT r.id,r.z01_ragic_record_id,COUNT(s.id)::int AS child_rows,
              COUNT(*) FILTER (WHERE NULLIF(s.name_normalized,'') IS NOT NULL)::int AS named_rows,
              COUNT(DISTINCT NULLIF(s.name_normalized,''))::int AS distinct_names
         FROM ragic_z03_records r
         LEFT JOIN ragic_z03_students s ON s.z03_record_id=r.id
        WHERE r.status='pending' AND r.phone_canonical ~ '^09[0-9]{8}$'
        GROUP BY r.id
     ), picked AS (
       (SELECT * FROM counts WHERE child_rows=0 ORDER BY random() LIMIT $1)
       UNION ALL
       (SELECT * FROM counts WHERE child_rows>0 AND named_rows>0 ORDER BY random() LIMIT $2)
     )
     SELECT * FROM picked ORDER BY child_rows,random()`,
    [ZERO_STUDENT_SAMPLES, SAMPLE_SIZE - ZERO_STUDENT_SAMPLES]
  )).rows;
  assert.strictEqual(selected.length, SAMPLE_SIZE, 'not enough eligible pending Z03 samples');

  for (const [index, sample] of selected.entries()) {
    sample.index = index;
    sample.sourceId = `ZZRANDOM${runId}${String(index).padStart(2, '0')}`;
    sample.phone = anonymousPhone(index);
    sample.lineUid = `U${digest(`${runId}:${index}`).slice(0, 32)}`;
    sample.parentName = `隨機抽樣家長${String(index).padStart(2, '0')}`;
    sample.children = (await pool.query(
      `SELECT seq_raw,name_normalized
         FROM ragic_z03_students WHERE z03_record_id=$1 ORDER BY seq_raw,id`,
      [sample.id]
    )).rows;
    const nameMap = new Map();
    for (const child of sample.children) {
      const normalized = String(child.name_normalized || '').trim();
      if (normalized && !nameMap.has(normalized)) {
        nameMap.set(normalized, syntheticName(index, nameMap.size));
      }
    }
    sample.syntheticNames = [...nameMap.values()];
    sample.selectedStudent = sample.syntheticNames[0] || syntheticName(index, 0);
    sample.childRows = Number(sample.child_rows);
    sample.namedRows = Number(sample.named_rows);
    sample.distinctNames = Number(sample.distinct_names);
    sample.anonymousFingerprint = digest(sample.z01_ragic_record_id).slice(0, 8);
    sample.nameMap = nameMap;
  }
  return selected;
}

function sourceRow(sample) {
  const subtable = {};
  sample.children.forEach((child, index) => {
    const normalized = String(child.name_normalized || '').trim();
    subtable[`row-${index + 1}`] = {
      1001120: child.seq_raw || String(index + 1),
      1001115: normalized ? sample.nameMap.get(normalized) : '',
      1001116: normalized ? '2018/03/04' : '',
      1001117: normalized ? '生理男' : '',
      1001118: '',
      1001132: normalized ? `RND-${sample.index}-${index + 1}` : '',
      1004090: normalized ? sample.phone : '',
    };
  });
  return {
    _ragicId: sample.sourceId,
    1001101: sample.parentName,
    1001100: sample.phone,
    1002820: '',
    1006846: '',
    109: '2026/07/14 12:00:00',
    _subtable_1001119: subtable,
  };
}

async function originalStateHash(samples) {
  const ids = samples.map((sample) => sample.id);
  const rows = (await pool.query(
    `SELECT r.id,r.status,r.classification,r.reason_code,r.claim_state,
            r.canonical_parent_id,r.canonical_student_id,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id',s.id,'canonical_student_id',s.canonical_student_id
            ) ORDER BY s.id) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) AS students
       FROM ragic_z03_records r
       LEFT JOIN ragic_z03_students s ON s.z03_record_id=r.id
      WHERE r.id=ANY($1::bigint[])
      GROUP BY r.id ORDER BY r.id`, [ids]
  )).rows;
  return digest(JSON.stringify(rows));
}

async function cleanup(samples) {
  if (!samples?.length) return;
  const sourceIds = samples.map((sample) => sample.sourceId);
  const phones = samples.map((sample) => sample.phone);
  const claims = (await pool.query(
    `SELECT id,canonical_parent_id FROM identity_claims WHERE source_record_id=ANY($1::text[])`,
    [sourceIds]
  )).rows;
  const claimIds = claims.map((row) => row.id);
  const parentRows = (await pool.query(
    `SELECT id FROM parents WHERE phone=ANY($1::text[])
      UNION SELECT canonical_parent_id AS id FROM identity_claims
       WHERE source_record_id=ANY($2::text[]) AND canonical_parent_id IS NOT NULL`,
    [phones, sourceIds]
  )).rows;
  const parentIds = [...new Set(parentRows.map((row) => row.id).filter(Boolean))];
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
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

(async () => {
  let samples = [];
  let server;
  const originalAxiosPost = axios.post;
  const originalRagic = {};
  let currentUid = '';
  let synchronousRagicCalls = 0;
  try {
    const nonSynced = Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM ragic_sync_outbox WHERE state NOT IN ('synced','cancelled')`
    )).rows[0].count);
    assert.strictEqual(nonSynced, 0, 'random simulation requires an empty non-synced local outbox');
    samples = await selectSamples();
    await cleanup(samples);
    const originalHash = await originalStateHash(samples);
    const venue = (await pool.query(`SELECT id FROM venues WHERE is_active=TRUE ORDER BY id LIMIT 1`)).rows[0];
    assert.ok(venue, 'active venue required');

    for (const sample of samples) {
      const raw = sourceRow(sample);
      await pool.query(
        `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
         VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`, [sample.sourceId, JSON.stringify(raw)]
      );
      await ragicAdmin.hydrateZ03RecordFromRagicRow(raw);
    }

    for (const name of ['getParentByPhone', 'getParentByLineUid', 'createParentWithStudentsInRagic']) {
      originalRagic[name] = ragic[name];
      ragic[name] = async () => {
        synchronousRagicCalls++;
        throw new Error(`unexpected synchronous Ragic call: ${name}`);
      };
    }
    axios.post = async () => ({ status: 200, data: { sub: currentUid, aud: 'z03-random-channel' } });
    process.env.LINE_LOGIN_CHANNEL_ID = 'z03-random-channel';
    process.env.PARENT_IDENTITY_RESOLVER_V2 = 'true';
    process.env.PARENT_LOCAL_FIRST = 'true';
    process.env.RAGIC_PARENT_OUTBOX = 'true';
    delete require.cache[require.resolve('../../server/services/lineAuth')];
    delete require.cache[require.resolve('../../server/routes/auth')];
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../../server/routes/auth'));
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    let bindCount = 0;
    let registrationCount = 0;
    for (const sample of samples) {
      currentUid = sample.lineUid;
      let result;
      if (sample.namedRows > 0) {
        const first = await postJson(server.address().port, '/api/auth/parent-bind-phone', {
          id_token: `random-bind-start-${sample.index}`, phone: sample.phone,
        });
        assert.strictEqual(first.response.status, 200, JSON.stringify(first.body));
        assert.strictEqual(first.body.status, 'need_claim_verification');
        result = await postJson(server.address().port, '/api/auth/parent-bind-phone', {
          id_token: `random-bind-claim-${sample.index}`,
          phone: sample.phone,
          claim: { student_name: sample.selectedStudent, phone: sample.phone, parent_name: sample.parentName },
        });
        bindCount++;
      } else {
        result = await postJson(server.address().port, '/api/auth/parent-register-line', {
          id_token: `random-register-${sample.index}`,
          parent: {
            name: sample.parentName, phone: sample.phone, email: '', gender: '生理女',
            primary_venue_id: venue.id,
          },
          students: [{
            name: sample.selectedStudent, id_number: 'A123456789', birth_date: '2018-03-04',
            gender: '生理男', blood_type: '不清楚',
          }],
        });
        registrationCount++;
      }
      assert.strictEqual(result.response.status, 200, `sample ${sample.index}: ${JSON.stringify(result.body)}`);
      assert.ok(['bound_and_logged_in', 'registered_and_logged_in'].includes(result.body.status));
      assert.ok(result.body.token);
      assert.strictEqual(result.body.sync_state, 'SYNC_PENDING');
      sample.parentId = result.body.parent.id;

      const login = await postJson(server.address().port, '/api/auth/parent-line-login', {
        id_token: `random-login-${sample.index}`,
      });
      assert.strictEqual(login.response.status, 200, JSON.stringify(login.body));
      assert.strictEqual(login.body.status, 'logged_in');
      assert.strictEqual(login.body.parent.id, sample.parentId);
    }
    assert.strictEqual(synchronousRagicCalls, 0);

    const sourceIds = samples.map((sample) => sample.sourceId);
    const aggregate = (await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM parents WHERE id=ANY($1::uuid[])) AS parents,
        (SELECT COUNT(*)::int FROM source_record_links WHERE source_record_id=ANY($2::text[])) AS links,
        (SELECT COUNT(*)::int FROM ragic_sync_outbox WHERE source_record_id=ANY($2::text[])) AS outbox,
        (SELECT COUNT(*)::int FROM ragic_z03_records
          WHERE z01_ragic_record_id=ANY($2::text[]) AND status='resolved') AS resolved`,
      [samples.map((sample) => sample.parentId), sourceIds]
    )).rows[0];
    assert.deepStrictEqual(aggregate, { parents: 10, links: 10, outbox: 10, resolved: 10 });

    const remote = new Map(samples.map((sample) => [sample.sourceId, {
      _ragicId: sample.sourceId, 1006846: '',
    }]));
    let parentWrites = 0;
    let studentAppends = 0;
    const processed = await processRagicSyncOutbox({
      limit: SAMPLE_SIZE,
      schemaGuard: async () => ({ verified: true }),
      reader: async (recordId) => ({ ...remote.get(String(recordId)) }),
      writer: async (patch, recordId, options) => {
        assert.strictEqual(options.includeResponseMetadata, true);
        Object.assign(remote.get(String(recordId)), patch);
        parentWrites++;
        return { data: { status: 'SUCCESS' }, responseMetadata: { httpStatus: 200 } };
      },
      studentWriter: async ({ parent }) => {
        studentAppends++;
        return { z01: null, z02: { ragicRecordId: `Z02-${parent.ragic_record_id}` },
          parentRagicRecordId: String(parent.ragic_record_id) };
      },
    });
    assert.deepStrictEqual(processed, { processed: 10, synced: 10, retryable: 0, blocked: 0 });
    assert.strictEqual(parentWrites, SAMPLE_SIZE);
    assert.strictEqual(studentAppends, ZERO_STUDENT_SAMPLES);
    assert.strictEqual(await originalStateHash(samples), originalHash, 'original random Z03 rows must remain unchanged');

    const jobs = (await pool.query(
      `SELECT state,attempts,COUNT(*)::int AS count
         FROM ragic_sync_outbox WHERE source_record_id=ANY($1::text[])
        GROUP BY state,attempts`, [sourceIds]
    )).rows;
    assert.deepStrictEqual(jobs, [{ state: 'synced', attempts: 1, count: 10 }]);

    console.log(JSON.stringify({
      test: 'Z03 random real-shape anonymous sample',
      result: 'PASS',
      samples: samples.map((sample) => ({
        fingerprint: sample.anonymousFingerprint,
        child_rows: sample.childRows,
        named_rows: sample.namedRows,
        distinct_names: sample.distinctNames,
        flow: sample.namedRows > 0 ? 'bind' : 'registration_append',
      })),
      bind_http_200: bindCount,
      registration_http_200: registrationCount,
      pending_login_http_200: SAMPLE_SIZE,
      synchronous_ragic_calls_during_login_or_registration: synchronousRagicCalls,
      outbox_synced: jobs[0].count,
      simulated_ragic_http_200: parentWrites,
      simulated_student_appends: studentAppends,
      original_z03_rows_unchanged: true,
    }, null, 2));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    axios.post = originalAxiosPost;
    Object.assign(ragic, originalRagic);
    delete process.env.PARENT_IDENTITY_RESOLVER_V2;
    delete process.env.PARENT_LOCAL_FIRST;
    delete process.env.RAGIC_PARENT_OUTBOX;
    await cleanup(samples);
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
