'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('status returns immediately and shares one sequential probe refresh', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/ragicAdmin.js'), 'utf8');
  const start = source.indexOf('async function getLiveRagicProbeSnapshot()');
  const end = source.indexOf('async function getSyncStatusSnapshot()', start);
  const pending = [];
  let calls = 0;
  const scope = { Date, Promise, Object, process: { env: { FIRST: '/first', SECOND: '/second' } },
    LIVE_PROBE_TTL_MS: 60000, LIVE_PROBE_FORMS: { first: { env: 'FIRST' }, second: { env: 'SECOND' } },
    _liveProbeCache: null, _liveProbeCacheAt: 0, _liveProbeInFlight: null,
    getRagicEnvFlags: () => ({ RAGIC_API_KEY: true, RAGIC_BASE_URL: true }),
    ragic: { probeForm: () => { calls++; return new Promise(resolve => pending.push(resolve)); } },
  };
  vm.runInNewContext(source.slice(start, end), scope);
  const refresh = scope.getLiveRagicProbeSnapshot();
  const first = await Promise.race([refresh, new Promise(resolve => setImmediate(() => resolve('blocked')))]);
  assert.notEqual(first, 'blocked', 'an external probe must not block the status page');
  assert.equal(first.pending, true);
  assert.equal(calls, 1, 'forms must be probed sequentially');
  await scope.getLiveRagicProbeSnapshot();
  assert.equal(calls, 1, 'concurrent status readers must share the same refresh');
  pending.shift()({ ok: true, count: 1, duration_ms: 1 });
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  pending.shift()({ ok: true, count: 1, duration_ms: 1 });
  await new Promise(setImmediate);
  const done = await scope.getLiveRagicProbeSnapshot();
  assert.equal(done.ok, true);
  assert.equal(done.pending, false);
  assert.equal(calls, 2, 'fresh results must be reused');
  scope._liveProbeCacheAt = 0;
  scope.ragic.probeForm = async () => { throw new Error('upstream unavailable'); };
  assert.equal((await scope.getLiveRagicProbeSnapshot()).pending, true);
  await new Promise(setImmediate);
  const failed = await scope.getLiveRagicProbeSnapshot();
  assert.equal(failed.pending, false);
  assert.equal(failed.ok, false);
  assert.equal(failed.forms.first.status, 'error');
  assert.equal(scope._liveProbeInFlight, null, 'failed probes must release the refresh');
});
