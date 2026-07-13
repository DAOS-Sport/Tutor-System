'use strict';

const assert = require('assert');
const { pool } = require('../../server/models/db');
const {
  captureParentLineProfile,
  getCachedParentLineProfile,
  resolveParentLineDisplayName,
} = require('../../server/services/parentLineProfile');
const enrollmentRouter = require('../../server/routes/admin/enrollments');

(async () => {
  const fixture = (await pool.query(
    `SELECT ae.id,p.line_uid
       FROM admin_enrollments ae
       JOIN parents p ON p.is_active=TRUE
        AND regexp_replace(COALESCE(p.phone,''),'\\D','','g') =
            regexp_replace(COALESCE(ae.parent_phone,''),'\\D','','g')
      WHERE COALESCE(p.line_uid,'')<>''
      ORDER BY ae.submitted_at DESC LIMIT 1`
  )).rows[0];
  assert.ok(fixture, 'a bound parent enrollment fixture is required');
  const previous = await getCachedParentLineProfile(fixture.line_uid);
  const testName = `LINE測試名稱${Date.now()}`.slice(0, 100);
  const rightsBefore = (await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM admin_enrollments) enrollments,
       (SELECT COALESCE(SUM(total_sessions),0)::text FROM course_periods) purchased,
       (SELECT COALESCE(SUM(used_sessions),0)::text FROM course_periods) used,
       (SELECT COUNT(*)::int FROM checkin_records) attendance`
  )).rows[0];
  try {
    const saved = await captureParentLineProfile({
      lineUid: fixture.line_uid,
      displayName: `  ${testName}\u0000  `,
      source: 'TEST',
    });
    assert.strictEqual(saved.display_name, testName);
    const cached = await resolveParentLineDisplayName({
      lineUid: fixture.line_uid,
      venueId: 'NO_NETWORK_EXPECTED',
      http: { get: async () => { throw new Error('cached lookup must not call LINE'); } },
    });
    assert.strictEqual(cached.state, 'CACHED');
    assert.strictEqual(cached.displayName, testName);
    const detail = await enrollmentRouter._lineProfileInternals.readEnrollment(fixture.id);
    assert.strictEqual(detail.line_bound, true);
    assert.strictEqual(detail.line_display_name, testName);
    const rightsAfter = (await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM admin_enrollments) enrollments,
         (SELECT COALESCE(SUM(total_sessions),0)::text FROM course_periods) purchased,
         (SELECT COALESCE(SUM(used_sessions),0)::text FROM course_periods) used,
         (SELECT COUNT(*)::int FROM checkin_records) attendance`
    )).rows[0];
    assert.deepStrictEqual(rightsAfter, rightsBefore);
    console.log('admin_enrollment_line_name_test: PASS (verified cache, enrollment detail, no rights mutation)');
  } finally {
    if (previous) {
      await pool.query(
        `INSERT INTO parent_line_profiles(line_uid,display_name,source,last_verified_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,NOW(),NOW())
         ON CONFLICT (line_uid) DO UPDATE SET display_name=EXCLUDED.display_name,
           source=EXCLUDED.source,last_verified_at=EXCLUDED.last_verified_at,updated_at=NOW()`,
        [previous.line_uid, previous.display_name, previous.source, previous.last_verified_at]
      );
    } else {
      await pool.query(`DELETE FROM parent_line_profiles WHERE line_uid=$1`, [fixture.line_uid]);
    }
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => pool.end());
