'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { Client } = require('../server/node_modules/pg');

// Create a disposable database only on an explicitly selected loopback test server.
(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL || '');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/daos_(audit|test)/);
  const name = 'daos_test_bootstrap_' + process.pid;
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = '/' + name;
    const script = `(async()=>{
      await require('./server/bootstrap/admin').bootstrap();
      await require('./server/bootstrap/coreSchema').bootstrap();
      await require('./server/bootstrap/coreSchema').bootstrap();
      const {pool}=require('./server/models/db');
      const r=await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name='course_periods' AND column_name='checkin_mode'");
      require('assert').equal(r.rows.length,1);
      require('assert').match(r.rows[0].column_default,/self/);
      // The Ragic Z03 upsert must be usable without a separate manual migration.
      await pool.query("EXPLAIN INSERT INTO ragic_z03_students (z03_record_id, source_row_key, name_raw) VALUES (NULL, 'bootstrap-probe', 'probe') ON CONFLICT (z03_record_id, source_row_key) DO NOTHING");
      await pool.end();
    })().catch(e=>{console.error(e);process.exit(1)});`;
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
      env: { PATH: process.env.PATH, NODE_PATH: path.join(__dirname, '../server/node_modules'),
        NODE_ENV: 'test', DATABASE_URL: url.toString(), HOME: process.env.HOME },
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    console.log('bootstrap_clean_database_test: PASS (fresh database and second bootstrap)');
  } finally {
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
