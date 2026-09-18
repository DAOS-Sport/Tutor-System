'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');
const field = '1006846';
function fixture({ remoteUid = '', mismatch = false, studentFailure = false, attempts = 1 } = {}) {
  const calls = []; const uid = 'U' + 'a'.repeat(32);
  const parent = { id: 'p', line_uid: uid, ragic_record_id: '42', email: 'current@example.test' };
  const query = async (sql) => {
    calls.push(sql);
    if (sql.includes('SELECT canonical_parent_id')) return { rows: [{ canonical_parent_id: 'p' }] };
    if (sql.includes('SELECT * FROM parents')) return { rows: [parent] };
    if (sql.includes('SELECT * FROM identity_claims')) return { rows: [{ id: 'c', canonical_parent_id: 'p', correlation_id: 'correlation' }] };
    return { rows: [], rowCount: 1 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const ragic = { fetchPage: async () => ({ rows: [] }), syncParentStudentsStrict: async () => { if (studentFailure) throw Object.assign(new Error('unconfirmed child'), { code: 'RAGIC_UNCONFIRMED_WRITE' }); } };
  const mod = { exports: {} };
  const file = process.env.OUTBOX_SOURCE || path.join(__dirname, '../services/ragicSyncOutbox.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: mod, exports: mod.exports, console, process: { env: {} },
    require(name) {
      if (name === '../models/db') return { pool };
      if (name === './ragic') return ragic;
      if (name === '../config/ragicSchema') return { RAGIC_Z01_FIELDS: { PARENT_SYSTEM_LINE_UID: field }, getTrueRagicLineUid: r => r?.[field] || '', STABILITY_FLAGS: {} };
      if (name === './ragicSchemaFreshness') return {};
      if (name === './parentRegistrationProfile') return {};
      if (name === './parentIdentityBackoffice') return { createParentIdentityBackofficeTask: async () => {} };
      throw Error(name);
    },
  });
  let writes = 0;
  return { calls, run: () => mod.exports.processClaimedRagicSyncOutboxJob({ id: 'j', claim_id: 'c', operation: 'CREATE_Z01_PARENT', attempts, max_attempts: 8, payload_reference: { students: [{ name: 'child' }] } }, {
    writer: async patch => { writes++; assert.equal(patch[field], uid); if (!mismatch) remoteUid = uid; },
    reader: async () => ({ _ragicId: '42', [field]: remoteUid }),
  }), writes: () => writes };
}
test('existing parent receives missing UID and must read back before synced', async () => {
  const f = fixture(); const r = await f.run();
  assert.equal(f.writes(), 1); assert.equal(r.outcome, 'synced'); assert.equal(r.readback_verified, true);
});
test('stale processing job beyond retry budget is blocked before any upstream write', async () => {
  const f = fixture({ attempts: 9 }); const result = await f.run();
  assert.equal(result.final_job_state, 'blocked_retry_exhausted');
  assert.equal(result.error_code, 'RAGIC_RETRY_EXHAUSTED');assert.equal(f.writes(),0);
  assert.equal(f.calls.some(sql => sql.includes('SELECT canonical_parent_id')),false);
});
test('conflicting UID is never overwritten or marked synced', async () => {
  const f = fixture({ remoteUid: 'U' + 'b'.repeat(32) }); const r = await f.run();
  assert.equal(f.writes(), 0); assert.equal(r.outcome, 'blocked'); assert.equal(r.error_code, 'PARENT_LINE_UID_MISMATCH');
});
test('unconfirmed write stays blocked', async () => {
  const f = fixture({ mismatch: true }); const r = await f.run();
  assert.equal(f.writes(), 1); assert.equal(r.outcome, 'blocked'); assert.equal(r.error_code, 'RAGIC_UNCONFIRMED_WRITE');
});

test('existing parent is not synced while its requested student remains unconfirmed', async () => {
  const f = fixture({ remoteUid: 'U' + 'a'.repeat(32), studentFailure: true });
  const r = await f.run(); assert.equal(r.outcome, 'blocked'); assert.equal(r.error_code, 'RAGIC_UNCONFIRMED_WRITE');
});
