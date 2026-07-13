'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../../server/models/db');
const parentSync = require('../../server/services/parentSync');
const { claimZ03Identity } = require('../../server/services/z03IdentityClaim');

const suffix = `${Date.now()}`.slice(-6);
const phone = `0963${suffix}`;
const lineUid = `Usafety${crypto.randomBytes(12).toString('hex')}`;
const sourceId = `ZZSAFETY${suffix}`;
let parentId = null;

async function cleanup() {
  const claims = await pool.query(`SELECT id,canonical_parent_id FROM identity_claims WHERE source_record_id=$1`, [sourceId]);
  const claimIds = claims.rows.map((row) => row.id);
  parentId = parentId || claims.rows.find((row) => row.canonical_parent_id)?.canonical_parent_id || null;
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
  }
  await pool.query(`DELETE FROM source_record_links WHERE source_record_id=$1`, [sourceId]);
  if (claimIds.length) await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  await pool.query(`DELETE FROM ragic_z03_records WHERE z01_ragic_record_id=$1`, [sourceId]);
  await pool.query(`DELETE FROM ragic_z01_shadow WHERE ragic_record_id=$1`, [sourceId]);
  if (parentId) {
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
}

(async () => {
  await cleanup();
  try {
    const parent = (await pool.query(
      `INSERT INTO parents(phone,name,is_active) VALUES ($1,'safety parent',TRUE) RETURNING *`, [phone]
    )).rows[0];
    parentId = parent.id;
    const student = (await pool.query(
      `INSERT INTO students(parent_id,name,id_number,is_active)
       VALUES ($1,'安全學員','A123456789',TRUE) RETURNING *`, [parent.id]
    )).rows[0];
    const family = (await pool.query(
      `INSERT INTO ragic_z03_records
         (z01_ragic_record_id,raw_name,phone,phone_canonical,status,classification,reason_code,claim_state)
       VALUES ($1,'safety source',$2,$2,'pending','PENDING_Z03','TRUE_LINE_UID_EMPTY','UNRESOLVED') RETURNING id`,
      [sourceId, phone]
    )).rows[0];
    await pool.query(
      `INSERT INTO ragic_z03_students
         (z03_record_id,name_raw,name_normalized,id_number_raw,source_row_key,classification,present_in_latest_payload)
       VALUES ($1,'安全學員','安全學員','B223456789','row-1','VALID',TRUE)`, [family.id]
    );
    await pool.query(
      `INSERT INTO ragic_z01_shadow(ragic_record_id,raw_data,fetched_at,last_seen_at,present_in_latest_pull)
       VALUES ($1,$2::jsonb,NOW(),NOW(),TRUE)`, [sourceId, JSON.stringify({ _ragicId: sourceId, 1006846: '' })]
    );
    await claimZ03Identity({ phone, studentName: '安全學員', lineUid, parentName: 'safety parent' });
    const afterStudent = (await pool.query(`SELECT id,id_number FROM students WHERE parent_id=$1`, [parent.id])).rows;
    assert.deepStrictEqual(afterStudent, [{ id: student.id, id_number: 'A123456789' }],
      'national ID conflict must not overwrite or create a second student');

    process.env.DESTRUCTIVE_RECONCILE_ENABLED = 'true';
    assert.strictEqual(await parentSync.hardDeleteParentIfSafe(pool, parent.id), false);
    assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM parents WHERE id=$1`, [parent.id])).rows[0].n, 1);
    assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM students WHERE id=$1`, [student.id])).rows[0].n, 1);

    const root = path.join(__dirname, '..', '..');
    const productFiles = [
      'server/routes/auth.js',
      'server/services/parentSync.js',
      'server/services/ragicAdmin.js',
      'server/services/z03IdentityClaim.js',
      'server/services/parentAccountRecovery.js',
      'server/services/ragicSyncOutbox.js',
    ];
    const source = productFiles.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    const authSource = fs.readFileSync(path.join(root, 'server/routes/auth.js'), 'utf8');
    assert.ok(!/DELETE\s+FROM\s+(parents|students)\b/i.test(source), 'release path must contain no parent/student hard delete SQL');
    assert.ok(!/SET\s+line_uid\s*=\s*(?:NULL|''|"")/i.test(source), 'release path must contain no LINE UID clearing SQL');
    assert.ok(!/PASSED_NOT_ON_FILE_ENABLED/.test(authSource), 'legacy flag must not enable passed_not_on_file auto-claim');
    assert.ok(!/result:\s*['"]passed_not_on_file['"]/.test(authSource), 'passed_not_on_file must never be audited as a successful claim');
    console.log('safety_invariants_test: PASS (national-ID no overwrite, no passed_not_on_file, no hard delete, no LINE UID clearing)');
  } finally {
    delete process.env.DESTRUCTIVE_RECONCILE_ENABLED;
    await cleanup();
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exit(1); });
