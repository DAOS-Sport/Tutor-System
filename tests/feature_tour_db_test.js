const assert = require('node:assert/strict');
const { pool } = require('../server/models/db');
const { SCHEMA_SQL, claimTour, TOUR_VERSION } = require('../server/services/featureTour');

(async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Only transaction-local temporary tables; never use or modify business tables.
    await db.query('SET LOCAL search_path = pg_temp');
    await db.query('CREATE TEMP TABLE parents (id UUID PRIMARY KEY, is_active BOOLEAN) ON COMMIT DROP');
    await db.query('CREATE TEMP TABLE coaches (id UUID PRIMARY KEY, is_active BOOLEAN) ON COMMIT DROP');
    await db.query('CREATE TEMP TABLE liff_feature_tours (role TEXT, account_id UUID, shown_at TIMESTAMPTZ) ON COMMIT DROP');
    await db.query(SCHEMA_SQL.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE') + ' ON COMMIT DROP');
    const id = '00000000-0000-4000-8000-000000000001';
    const other = '00000000-0000-4000-8000-000000000002';
    const inactive = '00000000-0000-4000-8000-000000000003';
    await db.query('INSERT INTO parents VALUES ($1,true),($2,true),($3,false)', [id, other, inactive]);
    await db.query('INSERT INTO coaches VALUES ($1,true)', [id]);
    await db.query("INSERT INTO liff_feature_tours VALUES ('parent',$1,'2026-09-01T00:00:00Z')", [id]);
    await db.query("INSERT INTO liff_feature_tour_runs (role,account_id,version) VALUES ('parent',$1,'older-version')", [id]);
    const old = (await db.query('SELECT * FROM liff_feature_tours')).rows;
    const earlierRun = (await db.query("SELECT * FROM liff_feature_tour_runs WHERE version='older-version'")).rows;
    assert.equal(await claimTour(db, 'parent', id), true);
    assert.equal(await claimTour(db, 'parent', id), false);
    assert.equal(await claimTour(db, 'coach', id), true);
    assert.equal(await claimTour(db, 'coach', id), false);
    const attempts = [];
    for (let i = 0; i < 10; i++) attempts.push(await claimTour(db, 'parent', other));
    assert.equal(attempts.filter(Boolean).length, 1);
    assert.equal(await claimTour(db, 'parent', inactive), false);
    assert.equal(await claimTour(db, 'coach', other), false);
    await assert.rejects(claimTour(db, 'admin', id), /Invalid tour identity/);
    await assert.rejects(claimTour(db, 'parent', 'invalid'), /Invalid tour identity/);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM liff_feature_tour_runs WHERE version=$1', [TOUR_VERSION])).rows[0].n, 3);
    assert.deepEqual((await db.query('SELECT * FROM liff_feature_tours')).rows, old, 'Original first-login records must remain intact');
    assert.deepEqual((await db.query("SELECT * FROM liff_feature_tour_runs WHERE version='older-version'")).rows, earlierRun, 'Previous-version history must remain intact');
    console.log('PASS: version replay once, old history preserved, role/account isolation, repeat requests, inactive/missing accounts; temporary tables only');
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
