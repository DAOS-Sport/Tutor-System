const assert = require('assert');

const {
  evaluateIndexes,
  sanitizedDatabaseIdentity,
  isDevelopmentDatabase,
} = require('../scripts/preflight_release_20260712');

function row(overrides = {}) {
  return {
    schema_name: 'public',
    table_name: 'course_periods',
    index_name: 'uq_course_periods_group_order',
    key_columns: ['group_order_id', 'period_number'],
    is_unique: true,
    is_valid: true,
    is_ready: true,
    predicate: '(group_order_id IS NOT NULL)',
    definition: 'CREATE UNIQUE INDEX uq_course_periods_group_order ON public.course_periods USING btree (group_order_id, period_number) WHERE (group_order_id IS NOT NULL)',
    ...overrides,
  };
}

assert.strictEqual(evaluateIndexes([row()]).status, 'PASS');
assert.strictEqual(evaluateIndexes([]).status, 'BLOCKED');
assert.strictEqual(evaluateIndexes([row({ key_columns: ['period_number', 'group_order_id'] })]).status, 'BLOCKED');
assert.strictEqual(evaluateIndexes([row({ is_unique: false })]).status, 'BLOCKED');
assert.strictEqual(evaluateIndexes([row({ predicate: null })]).status, 'BLOCKED');
const sameNameWrongTable = evaluateIndexes([row({ table_name: 'legacy_course_periods' })]);
assert.strictEqual(sameNameWrongTable.status, 'BLOCKED');
assert.ok(sameNameWrongTable.differences.some((difference) => difference.includes('table=legacy_course_periods')),
  'same-name index on the wrong table must be reported, not treated as simply absent');

const blockingLegacy = evaluateIndexes([
  row(),
  row({
    index_name: 'legacy_group_order_only',
    key_columns: ['group_order_id'],
    definition: 'CREATE UNIQUE INDEX legacy_group_order_only ON public.course_periods (group_order_id)',
  }),
]);
assert.strictEqual(blockingLegacy.status, 'BLOCKED', 'a legacy unique single-column index still prevents a second group period');
assert.ok(blockingLegacy.differences.some((difference) => difference.includes('legacy unique single-column')));
assert.strictEqual(blockingLegacy.legacy_single_column_indexes.length, 1, 'legacy mismatch must be reported explicitly');

const harmlessLegacy = evaluateIndexes([
  row(),
  row({
    index_name: 'legacy_group_order_lookup',
    key_columns: ['group_order_id'],
    is_unique: false,
    definition: 'CREATE INDEX legacy_group_order_lookup ON public.course_periods (group_order_id)',
  }),
]);
assert.strictEqual(harmlessLegacy.status, 'PASS', 'a non-unique lookup index does not block multi-period rows');
assert.strictEqual(harmlessLegacy.legacy_single_column_indexes.length, 1);

const identity = sanitizedDatabaseIdentity('postgresql://user:secret@helium:5432/heliumdb');
assert.deepStrictEqual(identity, { host: 'helium', port: '5432', database: 'heliumdb', ssl: null });
assert.strictEqual(isDevelopmentDatabase(identity), true);
assert.strictEqual(isDevelopmentDatabase({ host: 'prod.example.com' }), false);

console.log('preflight_release_20260712_test: PASS');
