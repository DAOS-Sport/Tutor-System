'use strict';

const assert = require('assert');
const {
  normalizeNodeId,
  parseArgs,
  preflightNode,
  safeJobResult,
} = require('../scripts/force_trigger_outbox');

assert.strictEqual(normalizeNodeId('739'), '739');
assert.throws(() => normalizeNodeId('00739'), /invalid Node ID/);
assert.throws(() => normalizeNodeId('0'), /invalid Node ID/);
assert.throws(() => normalizeNodeId('7x'), /invalid Node ID/);
assert.deepStrictEqual(
  parseArgs(['--node', '739', '--node', '433', '--node', '739']),
  { nodes: ['739', '433'], execute: false }
);
assert.deepStrictEqual(
  parseArgs(['--node', '739', '--execute', '--confirm-write']),
  { nodes: ['739'], execute: true }
);
assert.throws(() => parseArgs(['--node', '739', '--execute']), /both --execute and --confirm-write/);
assert.throws(() => parseArgs([]), /at least one --node/);

const baseJob = {
  id: 'job-id', correlation_id: 'correlation-id', source_record_id: '739', target_record_id: '739',
  operation: 'BIND_Z01_LINE_UID', state: 'pending', attempts: 0, canonical_line_uid: `U${'a'.repeat(32)}`,
};
assert.strictEqual(preflightNode('739', []).status, 'MISSING');
assert.strictEqual(preflightNode('739', [baseJob, { ...baseJob, id: 'job-2' }]).status, 'MULTIPLE');
assert.strictEqual(preflightNode('739', [{ ...baseJob, state: 'processing' }]).status, 'STATE_PROCESSING');
assert.strictEqual(preflightNode('739', [{ ...baseJob, state: 'retryable' }]).status, 'STATE_RETRYABLE');
assert.strictEqual(preflightNode('739', [{ ...baseJob, state: 'blocked_schema' }]).status, 'STATE_BLOCKED_SCHEMA');
assert.strictEqual(preflightNode('739', [{ ...baseJob, attempts: 1 }]).status, 'ATTEMPTS_NOT_ZERO');
assert.strictEqual(preflightNode('739', [{ ...baseJob, canonical_line_uid: '' }]).status, 'CANONICAL_LINE_UID_MISSING');
assert.strictEqual(preflightNode('739', [baseJob]).status, 'READY');
assert.strictEqual(preflightNode('739', [{ ...baseJob, state: 'synced' }]).status, 'ALREADY_SYNCED');
const safe = JSON.stringify(safeJobResult(preflightNode('739', [baseJob])));
assert.strictEqual(safe.includes(baseJob.canonical_line_uid), false, 'safe output must not contain LINE UID');

console.log('force_trigger_outbox_cli_test: PASS');
