#!/usr/bin/env node
'use strict';

const { Client } = require('../server/node_modules/pg');

const EXPECTED = Object.freeze({
  schema: 'public',
  table: 'course_periods',
  index: 'uq_course_periods_group_order',
  columns: ['group_order_id', 'period_number'],
  unique: true,
  predicate: 'group_order_id IS NOT NULL',
});

function normalizedPredicate(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[()\s"]/g, '');
}

function evaluateIndexes(rows) {
  const indexes = (rows || []).map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    index: row.index_name,
    columns: Array.isArray(row.key_columns) ? row.key_columns : [],
    unique: row.is_unique === true,
    valid: row.is_valid === true,
    ready: row.is_ready === true,
    predicate: row.predicate || null,
    definition: row.definition,
  }));
  // PostgreSQL index names share a schema namespace. A same-name index on the
  // wrong public table would make CREATE INDEX fail even though the target table
  // query alone looks merely "missing", so include and report that collision.
  const named = indexes.filter((index) => (
    index.schema === EXPECTED.schema && index.index === EXPECTED.index
  ));
  const actual = named[0] || null;
  const differences = [];

  if (named.length === 0) differences.push('expected index is missing');
  if (named.length > 1) differences.push(`expected one named index, found ${named.length}`);
  if (actual) {
    if (actual.schema !== EXPECTED.schema) differences.push(`schema=${actual.schema}, expected=${EXPECTED.schema}`);
    if (actual.table !== EXPECTED.table) differences.push(`table=${actual.table}, expected=${EXPECTED.table}`);
    if (actual.unique !== EXPECTED.unique) differences.push(`unique=${actual.unique}, expected=true`);
    if (!actual.valid) differences.push('index is not valid');
    if (!actual.ready) differences.push('index is not ready');
    if (JSON.stringify(actual.columns) !== JSON.stringify(EXPECTED.columns)) {
      differences.push(`columns=${JSON.stringify(actual.columns)}, expected=${JSON.stringify(EXPECTED.columns)}`);
    }
    if (normalizedPredicate(actual.predicate) !== normalizedPredicate(EXPECTED.predicate)) {
      differences.push(`predicate=${JSON.stringify(actual.predicate)}, expected=${JSON.stringify(EXPECTED.predicate)}`);
    }
  }

  const legacySingleColumn = indexes.filter((index) => (
    index.schema === EXPECTED.schema
    && index.table === EXPECTED.table
    && index.columns.length === 1
    && index.columns[0] === 'group_order_id'
  ));
  const blockingLegacyUnique = legacySingleColumn.filter((index) => index.unique);
  if (blockingLegacyUnique.length) {
    differences.push(
      `legacy unique single-column index still blocks multi-period groups: ${blockingLegacyUnique.map((index) => index.index).join(', ')}`
    );
  }
  return {
    status: differences.length ? 'BLOCKED' : 'PASS',
    expected: EXPECTED,
    actual,
    differences,
    legacy_single_column_indexes: legacySingleColumn,
    supports_constraint_inference: differences.length === 0,
  };
}

function sanitizedDatabaseIdentity(connectionString) {
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port || '5432',
      database: url.pathname.replace(/^\//, '') || null,
      ssl: url.searchParams.get('sslmode') || null,
    };
  } catch {
    return { host: null, port: null, database: null, ssl: null };
  }
}

function isDevelopmentDatabase(identity) {
  const host = String(identity.host || '').toLowerCase();
  return ['helium', 'localhost', '127.0.0.1', '::1'].includes(host)
    || host.endsWith('.local');
}

async function inspect(client) {
  const result = await client.query(
    `SELECT ns.nspname AS schema_name,
            tbl.relname AS table_name,
            idx.relname AS index_name,
            ind.indisunique AS is_unique,
            ind.indisvalid AS is_valid,
            ind.indisready AS is_ready,
            pg_get_expr(ind.indpred, ind.indrelid) AS predicate,
            ARRAY(
              SELECT pg_get_indexdef(ind.indexrelid, key_position, TRUE)
                FROM generate_series(1, ind.indnkeyatts) AS key_position
               ORDER BY key_position
            ) AS key_columns,
            pg_get_indexdef(ind.indexrelid) AS definition
       FROM pg_catalog.pg_index ind
       JOIN pg_catalog.pg_class idx ON idx.oid = ind.indexrelid
       JOIN pg_catalog.pg_class tbl ON tbl.oid = ind.indrelid
       JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      WHERE ns.nspname = $1
        AND (tbl.relname = $2 OR idx.relname = $3)
      ORDER BY idx.relname`,
    [EXPECTED.schema, EXPECTED.table, EXPECTED.index]
  );
  return evaluateIndexes(result.rows);
}

async function main() {
  const productionRequired = process.argv.includes('--production');
  const connectionString = process.env.DATABASE_URL;
  const database = sanitizedDatabaseIdentity(connectionString || '');
  const base = {
    check: 'release_20260712_group_period_index',
    mode: productionRequired ? 'production' : 'local_or_test',
    database,
    read_only: true,
  };

  if (!connectionString) {
    console.log(JSON.stringify({ ...base, status: 'BLOCKED', differences: ['DATABASE_URL is missing'] }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (productionRequired && isDevelopmentDatabase(database)) {
    console.log(JSON.stringify({
      ...base,
      status: 'BLOCKED',
      differences: [`production preflight refused development database host ${database.host}`],
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const evaluation = await inspect(client);
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ ...base, ...evaluation }, null, 2));
    if (evaluation.status !== 'PASS') process.exitCode = 2;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.log(JSON.stringify({
      ...base,
      status: 'BLOCKED',
      differences: ['catalog query failed'],
      error_code: error.code || 'PREFLIGHT_QUERY_FAILED',
    }, null, 2));
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = {
  EXPECTED,
  evaluateIndexes,
  sanitizedDatabaseIdentity,
  isDevelopmentDatabase,
  inspect,
};
