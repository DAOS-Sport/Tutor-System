// Regression: historical tombstones may not make a fetched blank-UID Ragic
// source disappear. Re-ingestion must preserve one Z03 row and surface it as
// manual_review; the old source id remains auditable.
const assert = require('assert');
const { pool } = require('../server/models/db');
const ragic = require('../server/services/ragic');
const ragicAdmin = require('../server/services/ragicAdmin');

async function testTombstoneBecomesManualReview() {
  const testId = 'ZZTEST-Z03-TOMBSTONE';
  const phone = '0999999911';
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id = $1`, [testId]);
  await pool.query(`DELETE FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = $1`, [testId]);
  try {
    await pool.query(
      `INSERT INTO ragic_z03_deleted_tombstones (z01_ragic_record_id, deleted_by, reason)
       VALUES ($1, $2, $3)`,
      [testId, 'test-admin', 'legacy tombstone']
    );
    const raw = {
      _ragicId: testId,
      [ragic.FIELD.Z01.PARENT_NAME]: '測試家長',
      [ragic.FIELD.Z01.PHONE]: phone,
      [ragic.FIELD.Z01.LINE_UID]: '',
      [ragic.FIELD.Z01.LINE_CHAT_URL]: 'https://line.example.invalid/chat',
      '109': '2026/07/13 09:00:00',
      _subtable_1001119: {
        row1: { '1001115': '測試學員' },
      },
    };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ragicAdmin.__test__.upsertZ03Record(client, testId, ragic.mapZ01Parent(raw), raw);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const row = (await pool.query(
      `SELECT status,classification,reason_code FROM ragic_z03_records
        WHERE z01_ragic_record_id=$1`,
      [testId]
    )).rows[0];
    assert.deepStrictEqual(row, {
      status: 'manual_review',
      classification: 'MANUAL_REVIEW',
      reason_code: 'LEGACY_TOMBSTONE_RETAINED',
    });
    assert.strictEqual((await pool.query(
      `SELECT COUNT(*)::int AS n FROM ragic_z03_students zs
        JOIN ragic_z03_records zr ON zr.id=zs.z03_record_id
       WHERE zr.z01_ragic_record_id=$1`,
      [testId]
    )).rows[0].n, 1);
  } finally {
    await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id = $1`, [testId]);
    await pool.query(`DELETE FROM ragic_z03_deleted_tombstones WHERE z01_ragic_record_id = $1`, [testId]);
  }
}

(async () => {
  await testTombstoneBecomesManualReview();
  console.log('ragic_z03_tombstone_test: PASS');
  await pool.end();
})().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
