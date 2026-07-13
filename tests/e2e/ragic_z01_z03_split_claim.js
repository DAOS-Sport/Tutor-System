'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');
const ragicAdmin = require('../../server/services/ragicAdmin');
const parentSync = require('../../server/services/parentSync');
const { claimZ03Identity, Z03ClaimError } = require('../../server/services/z03IdentityClaim');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');
const { normalizePhone, normalizeStudentName } = require('../../server/services/identityNormalizer');

const suffix = String(Date.now()).slice(-5) + String(process.pid % 10);
const prefix = `ZZZ03${suffix}`;
const sourceIds = {
  claim: `${prefix}A`,
  noMatch: `${prefix}B`,
  ambiguous: `${prefix}C`,
  formal1: `${prefix}D`,
  formal2: `${prefix}E`,
  missing: `${prefix}F`,
};
const phones = {
  claim: `0987${suffix}`,
  noMatch: `0986${suffix}`,
  ambiguous: `0985${suffix}`,
  formal: `0984${suffix}`,
};
const lineUids = {
  claim: `U${crypto.randomBytes(16).toString('hex')}`,
  formal: `U${crypto.randomBytes(16).toString('hex')}`,
};

function sourceRow({ id, phone, lineUid = '', parentName = '測試家長', students = [], updated = '2026/07/13 08:30:00', chatUrl = 'https://line.example.invalid/chat' }) {
  const sub = {};
  students.forEach((student, index) => {
    sub[`row-${index + 1}`] = {
      '1001120': student.seq || String(index + 1),
      '1001115': student.name || '',
      '1001116': student.birth || '',
      '1001117': student.gender || '',
      '1001118': student.nationalId || '',
      '1001132': student.studentCode || '',
      '1004090': student.registeredPhone || '',
    };
  });
  return {
    _ragicId: id,
    [ragic.FIELD.Z01.PARENT_NAME]: parentName,
    [ragic.FIELD.Z01.PHONE]: phone,
    [ragic.FIELD.Z01.LINE_UID]: lineUid,
    [ragic.FIELD.Z01.LINE_CHAT_URL]: chatUrl,
    '1002830': '已建立',
    '109': updated,
    _subtable_1001119: sub,
  };
}

async function upsertZ03(raw) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ragicAdmin.__test__.upsertZ03Record(client, String(raw._ragicId), ragic.mapZ01Parent(raw), raw);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function syncFormal(raw) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const venuesMap = await parentSync.loadVenuesMap(client);
    const result = await ragicAdmin.__test__.syncCanonicalZ01Record(
      client,
      raw,
      ragic.mapZ01Parent(raw),
      venuesMap
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function cleanup() {
  const ids = Object.values(sourceIds);
  await pool.query(`DELETE FROM ragic_sync_outbox WHERE source_record_id = ANY($1::text[])`, [ids]);
  await pool.query(
    `DELETE FROM identity_claim_events e USING identity_claims c
      WHERE e.claim_id=c.id AND c.source_record_id=ANY($1::text[])`,
    [ids]
  );
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id = ANY($1::text[])`, [ids]);
  await pool.query(`DELETE FROM identity_claims WHERE source_record_id = ANY($1::text[])`, [ids]);
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id = ANY($1::text[])`, [ids]);
  await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id = ANY($1::text[])`, [ids]);
  const parentRows = await pool.query(
    `SELECT id FROM parents WHERE phone = ANY($1::text[]) OR line_uid = ANY($2::text[])`,
    [Object.values(phones), Object.values(lineUids)]
  );
  const parentIds = parentRows.rows.map((row) => row.id);
  if (parentIds.length) {
    await pool.query(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [parentIds]);
    await pool.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [parentIds]);
  }
  await pool.query(`DELETE FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = ANY($1::text[])`, [ids]);
}

async function testNormalization() {
  assert.strictEqual(normalizePhone('+886 987-123-456'), '0987123456');
  assert.strictEqual(normalizePhone('０９８７１２３４５６'), '0987123456');
  assert.strictEqual(normalizeStudentName(' 王　小 明 '), normalizeStudentName('王小明'));
}

async function testSplitAndIdempotentZ03() {
  const raw = sourceRow({
    id: sourceIds.claim,
    phone: `+886${phones.claim.slice(1)}`,
    students: [
      { name: '王 小明', birth: '2015/03/02', gender: '生理男', nationalId: 'A123456789', studentCode: 'S-1' },
      { name: '', birth: '', gender: '' },
    ],
  });
  assert.strictEqual(ragicAdmin.__test__.trueZ01LineUid(raw), '', 'chat URL/status text must not count as true UID');
  assert.strictEqual(ragic.parseZ01StudentsRaw(raw).length, 2, 'blank/error subtable rows must be preserved');
  await upsertZ03(raw);
  await upsertZ03({ ...raw, [ragic.FIELD.Z01.PARENT_NAME]: '測試家長更新' });

  const record = await pool.query(
    `SELECT * FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [sourceIds.claim]
  );
  assert.strictEqual(record.rowCount, 1, 'same source record must upsert one Z03 row');
  assert.strictEqual(record.rows[0].phone_canonical, phones.claim);
  assert.strictEqual(record.rows[0].status, 'pending');
  assert.strictEqual(record.rows[0].source_updated_raw, '2026/07/13 08:30:00');
  const children = await pool.query(
    `SELECT * FROM ragic_z03_students WHERE z03_record_id=$1 ORDER BY id`, [record.rows[0].id]
  );
  assert.strictEqual(children.rowCount, 2, 'all source subtable rows must persist');
}

async function testLocalFirstClaimAndOutbox() {
  const first = await claimZ03Identity({
    phone: phones.claim,
    studentName: '王　小明',
    lineUid: lineUids.claim,
    parentName: '測試家長',
  });
  assert.strictEqual(first.replayed, false);
  assert.strictEqual(first.sync_state, 'SYNC_PENDING');

  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM parents WHERE phone=$1) AS parents,
       (SELECT COUNT(*)::int FROM students WHERE parent_id=$2) AS students,
       (SELECT COUNT(*)::int FROM source_record_links WHERE source_record_id=$3) AS links,
       (SELECT COUNT(*)::int FROM ragic_sync_outbox WHERE source_record_id=$3) AS outbox,
       (SELECT status FROM ragic_z03_records WHERE z01_ragic_record_id=$3) AS z03_status`,
    [phones.claim, first.parent.id, sourceIds.claim]
  );
  assert.deepStrictEqual(counts.rows[0], { parents: 1, students: 1, links: 1, outbox: 1, z03_status: 'resolved' });

  const retry = await claimZ03Identity({
    phone: `+886${phones.claim.slice(1)}`,
    studentName: '王小明',
    lineUid: lineUids.claim,
  });
  assert.strictEqual(retry.replayed, true);
  assert.strictEqual(retry.parent.id, first.parent.id);
  assert.strictEqual(retry.student.id, first.student.id);

  const afterRetry = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM parents WHERE phone=$1) AS parents,
       (SELECT COUNT(*)::int FROM students WHERE parent_id=$2) AS students,
       (SELECT COUNT(*)::int FROM ragic_sync_outbox WHERE source_record_id=$3) AS outbox`,
    [phones.claim, first.parent.id, sourceIds.claim]
  );
  assert.deepStrictEqual(afterRetry.rows[0], { parents: 1, students: 1, outbox: 1 });

  const idempotencyKey = `bind-z01-line-uid:${sourceIds.claim}`;
  const failed = await processRagicSyncOutbox({
    limit: 1,
    idempotencyKey,
    schemaGuard: async () => ({ verified: true }),
    writer: async () => {
      const err = new Error('simulated timeout');
      err.code = 'RAGIC_TIMEOUT';
      throw err;
    },
  });
  assert.deepStrictEqual(failed, { processed: 1, synced: 0, retryable: 1, blocked: 0 });
  const localAfterTimeout = await pool.query(`SELECT line_uid FROM parents WHERE id=$1`, [first.parent.id]);
  assert.strictEqual(localAfterTimeout.rows[0].line_uid, lineUids.claim, 'Ragic timeout must not roll back local login identity');
  await pool.query(
    `UPDATE ragic_sync_outbox SET next_retry_at=NOW() WHERE idempotency_key=$1`, [idempotencyKey]
  );
  let writes = 0;
  const succeeded = await processRagicSyncOutbox({
    limit: 1,
    idempotencyKey,
    schemaGuard: async () => ({ verified: true }),
    writer: async (payload, recordId) => {
      writes++;
      assert.strictEqual(recordId, sourceIds.claim);
      assert.strictEqual(payload[ragic.FIELD.Z01.LINE_UID], lineUids.claim);
    },
  });
  assert.deepStrictEqual(succeeded, { processed: 1, synced: 1, retryable: 0, blocked: 0 });
  assert.strictEqual(writes, 1);
}

async function testZeroAndAmbiguousMatchesFailClosed() {
  await upsertZ03(sourceRow({
    id: sourceIds.noMatch,
    phone: phones.noMatch,
    students: [{ name: '既有學生' }],
  }));
  await assert.rejects(
    () => claimZ03Identity({ phone: phones.noMatch, studentName: '不存在學生', lineUid: `U${crypto.randomBytes(16).toString('hex')}` }),
    (err) => err instanceof Z03ClaimError && err.code === 'MANUAL_REVIEW_REQUIRED'
  );
  const noMatch = await pool.query(
    `SELECT status,reason_code FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [sourceIds.noMatch]
  );
  assert.deepStrictEqual(noMatch.rows[0], { status: 'manual_review', reason_code: 'IDENTITY_NOT_FOUND' });
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int AS n FROM parents WHERE phone=$1`, [phones.noMatch])).rows[0].n, 0);

  await upsertZ03(sourceRow({
    id: sourceIds.ambiguous,
    phone: phones.ambiguous,
    students: [{ name: '同名學生', seq: '1' }, { name: '同名 學生', seq: '2' }],
  }));
  await assert.rejects(
    () => claimZ03Identity({ phone: phones.ambiguous, studentName: '同名學生', lineUid: `U${crypto.randomBytes(16).toString('hex')}` }),
    (err) => err instanceof Z03ClaimError && err.code === 'AMBIGUOUS_STUDENT_MATCH'
  );
  assert.strictEqual((await pool.query(
    `SELECT status FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [sourceIds.ambiguous]
  )).rows[0].status, 'manual_review');
}

async function testTrueUidGoesFormalOnlyAndSharesCanonicalParent() {
  const firstRaw = sourceRow({
    id: sourceIds.formal1,
    phone: `+886${phones.formal.slice(1)}`,
    lineUid: lineUids.formal,
    students: [{ name: '正式學生甲' }],
  });
  const secondRaw = sourceRow({
    id: sourceIds.formal2,
    phone: phones.formal,
    lineUid: lineUids.formal,
    students: [{ name: '正式學生乙' }],
  });
  assert.strictEqual(ragicAdmin.__test__.trueZ01LineUid(firstRaw), lineUids.formal);
  const first = await syncFormal(firstRaw);
  const second = await syncFormal(secondRaw);
  assert.strictEqual(first.parent.id, second.parent.id, 'same canonical phone must not create a second parent');
  const state = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM parents WHERE phone=$1) AS parents,
       (SELECT COUNT(*)::int FROM students WHERE parent_id=$2) AS students,
       (SELECT COUNT(*)::int FROM source_record_links WHERE source_record_id=ANY($3::text[])) AS links,
       (SELECT COUNT(*)::int FROM ragic_z03_records WHERE z01_ragic_record_id=ANY($3::text[])) AS z03`,
    [phones.formal, first.parent.id, [sourceIds.formal1, sourceIds.formal2]]
  );
  assert.deepStrictEqual(state.rows[0], { parents: 1, students: 2, links: 2, z03: 0 });
}

async function testBlankUidCoverageInvariant() {
  const raw = sourceRow({ id: sourceIds.missing, phone: `0983${suffix}`, students: [{ name: '對帳學生' }] });
  await pool.query(
    `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at)
     VALUES ($1,$2::jsonb,NOW())`,
    [sourceIds.missing, JSON.stringify(raw)]
  );
  const blocked = await ragicAdmin.reconcileZ01BlankUidCoverage();
  assert.strictEqual(blocked.pass, false);
  assert.ok(blocked.missing_source_ids.includes(sourceIds.missing));
  await upsertZ03(raw);
  const pass = await ragicAdmin.reconcileZ01BlankUidCoverage();
  assert.ok(!pass.missing_source_ids.includes(sourceIds.missing), 'target source must be accounted even when dev DB has unrelated backlog');
}

(async () => {
  await cleanup();
  try {
    await testNormalization();
    await testSplitAndIdempotentZ03();
    await testLocalFirstClaimAndOutbox();
    await testZeroAndAmbiguousMatchesFailClosed();
    await testTrueUidGoesFormalOnlyAndSharesCanonicalParent();
    await testBlankUidCoverageInvariant();
    console.log('ragic_z01_z03_split_claim: PASS (6 suites)');
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
