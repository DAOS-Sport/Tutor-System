'use strict';

// Read-only daily-node view. Arbitrary point-in-time restore is deliberately absent.
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { decodeCheckpoint } = require('./ragicShadowReplayBridge');
const MAX_ROWS = 5000;
function failure(code, status = 422) { return Object.assign(new Error(code), { code, status }); }

function createReplayRunner(binary) {
  if (!path.isAbsolute(binary)) throw failure('TIMELINE_BINARY_PATH_INVALID');
  binary = path.resolve(binary);
  return function runReplay(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['replay-stdin'], { shell: false, windowsHide: true, cwd: path.dirname(binary),
      env: { LANG: 'C', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(failure('TIMELINE_REPLAY_TIMEOUT', 503)); }, 10000);
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { child.kill(); finish(failure('TIMELINE_REPLAY_LIMIT')); } else output += chunk; });
    child.stderr.resume(); // Never return decrypted data, keys, or child diagnostics to the API.
    child.on('error', () => finish(failure('TIMELINE_REPLAY_UNAVAILABLE', 503)));
    child.on('close', (code) => {
      if (code !== 0) return finish(failure('TIMELINE_REPLAY_REJECTED'));
      try { finish(null, JSON.parse(output)); } catch { finish(failure('TIMELINE_REPLAY_INVALID')); }
    });
    child.stdin.on('error', () => finish(failure('TIMELINE_REPLAY_UNAVAILABLE', 503)));
    child.stdin.end(JSON.stringify({ command: 'replay', payload }));
  });
  };
}
const runReplay = createReplayRunner(path.resolve(__dirname, '../../tools/ragic-shadow-core/bin', process.platform === 'win32' ? 'ragic-shadow-core.exe' : 'ragic-shadow-core'));

function createTimeline({ pool, enabled = false, expectedTargetHash, replay = runReplay, schema, syntheticOnly = false }) {
  if (schema !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw failure('TIMELINE_SCHEMA_INVALID');
  async function read(work) {
    if (!enabled) throw failure('TIMELINE_DISABLED', 404);
    const client = await pool.connect();
    try {
      const p = client.connectionParameters;
      const actual = p && crypto.createHash('sha256').update(JSON.stringify([p.host.toLowerCase(), p.database, Number(p.port)])).digest('hex');
      if (!/^[a-f0-9]{64}$/.test(expectedTargetHash || '') || actual !== expectedTargetHash) throw failure('TIMELINE_TARGET_REFUSED', 503);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='4000ms'");
      if (schema !== undefined) {
        const namespace = await client.query(`SELECT n.oid FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid WHERE n.nspname=$1 AND c.relname='ragic_shadow_checkpoints' AND c.relkind='r'`, [schema]);
        if (namespace.rowCount !== 1) throw failure('TIMELINE_SCHEMA_UNAVAILABLE', 503);
        // Transaction-local only: normal application queries retain their original schema.
        await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
      }
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error.code && error.code.startsWith('TIMELINE_') ? error : failure('TIMELINE_UNAVAILABLE', 503);
    } finally { client.release(); }
  }
  function node(row) {
    return { id: row.checkpoint_id, businessDate: row.business_date, requestedCutoff: row.requested_cutoff,
      actualCutoff: row.actual_cutoff, boundaryMet: row.boundary_met, readOnly: true };
  }
  return {
    async list() {
      return read(async (client) => ({ nodes: (await client.query(`SELECT checkpoint_id,business_date::text,requested_cutoff,actual_cutoff,boundary_met
        FROM ragic_shadow_checkpoints WHERE status='complete' ORDER BY actual_cutoff DESC LIMIT 90`)).rows.map(node), readOnly: true, syntheticOnly, granularity: 'daily-node' }));
    },
    async get(id) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw failure('TIMELINE_INVALID_NODE', 400);
      const { row, snapshot } = await read(async (client) => {
        const row = (await client.query(`SELECT *,business_date::text FROM ragic_shadow_checkpoints WHERE checkpoint_id=$1 AND status='complete'`, [id])).rows[0];
        if (!row) throw failure('TIMELINE_NODE_NOT_FOUND', 404);
        let snapshot;
        try { ({ snapshot } = decodeCheckpoint(row)); } catch { throw failure('TIMELINE_NODE_UNVERIFIABLE'); }
        const actualTime = Date.parse(snapshot.actual_cutoff), requestedTime = Date.parse(snapshot.requested_cutoff);
        if (!Number.isFinite(actualTime) || !Number.isFinite(requestedTime) || snapshot.business_date !== row.business_date
          || actualTime !== row.actual_cutoff.valueOf() || requestedTime !== row.requested_cutoff.valueOf()
          || row.boundary_met !== (Math.abs(actualTime - requestedTime) <= 1000)) throw failure('TIMELINE_NODE_UNVERIFIABLE');
        return { row, snapshot };
      });
      const parents = snapshot.tables.parents, students = snapshot.tables.students;
      if (!Array.isArray(parents) || !Array.isArray(students) || parents.length + students.length > MAX_ROWS) throw failure('TIMELINE_ROW_LIMIT');
      const entries = [...parents.map((r) => [`parent:${r.id}`, r]), ...students.map((r) => [`student:${r.id}`, r])];
      if (new Set(entries.map(([id]) => id)).size !== entries.length) throw failure('TIMELINE_NODE_UNVERIFIABLE');
      const result = await replay({ contract_version: 1, replay_schema_version: 2, snapshot: Object.fromEntries(entries),
        snapshot_versions: snapshot.entity_versions, snapshot_event_ids: snapshot.event_manifest.event_ids,
        target_event_ids: [], transaction_manifest: [], events: [] });
      if (!result.rows || Object.keys(result.rows).length !== entries.length) throw failure('TIMELINE_REPLAY_INVALID');
      // Presentation projection: never expose identity numbers, LINE UIDs, encrypted envelopes or grant tokens.
      const rows = Object.entries(result.rows).map(([key, value]) => ({ key, id: value.id, name: value.name ?? null,
        ...(key.startsWith('student:') ? { parentId: value.parent_id ?? null, birthDate: value.birth_date ?? null } : {}) }));
      return { node: node(row), rows, readOnly: true, syntheticOnly, granularity: 'daily-node', currentDataChanged: false };
    },
  };
}
module.exports = { createTimeline, runReplay, createReplayRunner };
