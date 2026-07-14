// Regression coverage for Z03 parent/student clean delete semantics.
const assert = require('assert');
const { pool } = require('../server/models/db');
const ragic = require('../server/services/ragic');
const ragicAdmin = require('../server/services/ragicAdmin');

const SOURCE_ID = 'ZZTEST-Z03-CLEAN-DELETE';
const PHONE = '0999999928';

async function cleanup() {
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [SOURCE_ID]);
  await pool.query(`DELETE FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id=$1`, [SOURCE_ID]);
  await pool.query(`DELETE FROM ragic_z03_deleted_student_tombstones WHERE z01_ragic_record_id=$1`, [SOURCE_ID]);
}

async function seedFamily() {
  const family = (await pool.query(
    `INSERT INTO ragic_z03_records
       (z01_ragic_record_id,raw_name,phone,status,classification,reason_code)
     VALUES ($1,'測試家長',$2,'pending','PENDING_Z03','TRUE_LINE_UID_EMPTY')
     RETURNING id`,
    [SOURCE_ID, PHONE]
  )).rows[0];
  const students = (await pool.query(
    `INSERT INTO ragic_z03_students
       (z03_record_id,seq_raw,name_raw,source_row_key,classification,present_in_latest_payload)
     VALUES ($1,'1','第一位學員','1:0','VALID',TRUE),
            ($1,'2','第二位學員','2:1','VALID',TRUE)
     RETURNING id,name_raw,source_row_key`,
    [family.id]
  )).rows;
  students.sort((a, b) => Number(a.id) - Number(b.id));
  return { family, students };
}

function rawRagicFamily() {
  return {
    _ragicId: SOURCE_ID,
    [ragic.FIELD.Z01.PARENT_NAME]: '測試家長',
    [ragic.FIELD.Z01.PHONE]: PHONE,
    [ragic.FIELD.Z01.LINE_UID]: '',
    _subtable_1001119: {
      row1: { '1001120': '1', '1001115': '第一位學員' },
      row2: { '1001120': '2', '1001115': '第二位學員' },
    },
  };
}

async function reingest(raw) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await ragicAdmin.__test__.upsertZ03Record(
      client, SOURCE_ID, ragic.mapZ01Parent(raw), raw
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

async function testStudentCleanDelete() {
  const { family, students } = await seedFamily();
  const oneLeft = await ragicAdmin.saveZ03RecordDraft(family.id, {
    record: {},
    students: [{ id: students[0].id, name_raw: students[0].name_raw, seq_raw: '1' }],
  }, 'test-admin');
  assert.strictEqual(oneLeft.item.students.length, 1, 'N students minus one must equal N-1');
  assert.strictEqual(String(oneLeft.item.students[0].id), String(students[0].id));

  const empty = await ragicAdmin.saveZ03RecordDraft(family.id, {
    record: {},
    students: [null, {}, { id: students[0].id, name_raw: '', seq_raw: '' }],
  }, 'test-admin');
  assert.deepStrictEqual(empty.item.students, [], 'last student delete must persist a clean []');
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int n FROM ragic_z03_students WHERE z03_record_id=$1`, [family.id]
  )).rows[0].n, 0);
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int n FROM ragic_z03_deleted_student_tombstones
      WHERE z01_ragic_record_id=$1`, [SOURCE_ID]
  )).rows[0].n, 2);

  await reingest(rawRagicFamily());
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int n FROM ragic_z03_students WHERE z03_record_id=$1`, [family.id]
  )).rows[0].n, 0, 'deleted source students must not regrow on the next pull');
}

async function testParentHardDelete() {
  const family = (await pool.query(
    `SELECT id FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [SOURCE_ID]
  )).rows[0];
  const result = await ragicAdmin.deleteZ03Record(family.id, { adminUsername: 'test-admin' });
  assert.strictEqual(result.deleted, true);
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int n FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [SOURCE_ID]
  )).rows[0].n, 0);
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int n FROM ragic_z03_students WHERE z03_record_id=$1`, [family.id]
  )).rows[0].n, 0, 'parent delete must cascade to students');

  const reingestResult = await reingest(rawRagicFamily());
  assert.deepStrictEqual(reingestResult, { skipped: true, reason: 'ADMIN_HARD_DELETE' });
  assert.strictEqual((await pool.query(
    `SELECT COUNT(*)::int n FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [SOURCE_ID]
  )).rows[0].n, 0, 'hard-deleted family must not regrow on the next pull');
}

(async () => {
  await cleanup();
  try {
    await testStudentCleanDelete();
    await testParentHardDelete();
    console.log('ragic_z03_clean_delete_test: PASS');
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
