const assert = require('node:assert/strict');
const { pool } = require('../server/models/db');
const { SCHEMA_SQL, claimTour } = require('../server/services/featureTour');

(async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Only transaction-local temporary tables; never use or modify business tables.
    await db.query('SET LOCAL search_path = pg_temp');
    await db.query('CREATE TEMP TABLE parents (id UUID PRIMARY KEY, is_active BOOLEAN) ON COMMIT DROP');
    await db.query('CREATE TEMP TABLE coaches (id UUID PRIMARY KEY, is_active BOOLEAN) ON COMMIT DROP');
    await db.query(SCHEMA_SQL.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE') + ' ON COMMIT DROP');
    const id = '00000000-0000-4000-8000-000000000001';
    const other = '00000000-0000-4000-8000-000000000002';
    const inactive = '00000000-0000-4000-8000-000000000003';
    await db.query('INSERT INTO parents VALUES ($1,true),($2,true),($3,false)', [id, other, inactive]);
    await db.query('INSERT INTO coaches VALUES ($1,true)', [id]);
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
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM liff_feature_tours')).rows[0].n, 3);
    console.log('PASS: PostgreSQL unique claim, role/account isolation, repeat requests, inactive/missing accounts; temporary tables only');
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
