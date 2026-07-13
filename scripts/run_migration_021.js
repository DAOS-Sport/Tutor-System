#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('../server/node_modules/pg');
const {
  sanitizedDatabaseIdentity,
  isDevelopmentDatabase,
} = require('./preflight_release_20260712');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '021_release_ops_hardening.sql');

async function main() {
  const execute = process.argv.includes('--execute');
  const productionConfirmed = process.argv.includes('--production-confirmed');
  const connectionString = process.env.DATABASE_URL;
  const database = sanitizedDatabaseIdentity(connectionString || '');
  const output = {
    migration: path.basename(MIGRATION),
    mode: execute ? 'execute' : 'dry-run',
    database,
  };

  if (!connectionString) {
    console.log(JSON.stringify({ ...output, status: 'BLOCKED', reason: 'DATABASE_URL is missing' }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (productionConfirmed && isDevelopmentDatabase(database)) {
    console.log(JSON.stringify({ ...output, status: 'BLOCKED', reason: 'production flag points to development database' }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (!isDevelopmentDatabase(database) && execute && !productionConfirmed) {
    console.log(JSON.stringify({
      ...output,
      status: 'BLOCKED',
      reason: 'non-development execution requires --production-confirmed after release preflight approval',
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query('BEGIN');
    // Production 必須快速失敗，不可長時間卡住營運交易。021 只允許一般 transaction
    // 可執行的 additive DDL；不包含 CONCURRENTLY 或任何 destructive statement。
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(sql);
    await client.query(execute ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({
      ...output,
      status: 'PASS',
      transaction_result: execute ? 'COMMITTED' : 'ROLLED_BACK',
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.log(JSON.stringify({
      ...output,
      status: 'BLOCKED',
      transaction_result: 'ROLLED_BACK',
      error_code: error.code || 'MIGRATION_FAILED',
      reason: 'single migration failed',
    }, null, 2));
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
