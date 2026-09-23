'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const service = n => fs.readFileSync(path.join(__dirname, '../services', n + '.js'), 'utf8');

test('LINE quota backoff preserves unsent status, retry eligibility and HTTP evidence', async () => {
  let now = 100000, posts = 0, warnings = 0;
  const finishes = [], replies = [{ status: 429, data: { message: 'You have reached your monthly limit.' } }, { status: 200 }, { status: 500, data: { message: 'server error' } }];
  const mod = { exports: {} };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(service('line'), { module: mod, exports: mod.exports, Date: Clock,
    process: { env: { LINE_MESSAGING_TOKEN_test: 'not-a-real-token' } },
    console: { warn() { warnings++; }, error() {} },
    require(n) {
      if (n === 'axios') return { post: async () => { posts++; return replies.shift(); } };
      if (n === './lineRouting') return { STAFF_CHANNEL: 'test' };
      if (n === './pushGate') return { decide: async () => ({ allow: true, uid: 'u' }), claim: async () => finishes.length + 1, finish: async x => finishes.push(x) };
      throw Error(n);
    },
  });
  const line = mod.exports;
  assert.equal((await line.pushMessage('u', [])).reason, 'MONTHLY_QUOTA_EXHAUSTED');
  assert.equal((await line.pushMessage('u', [])).sent, false);
  assert.equal(posts, 1);
  assert.equal(warnings, 1);
  assert.equal(finishes.length, 2);
  assert.equal(finishes[0].httpStatus, 429);
  assert.ok(finishes.every(x => x.status === 'failed'), 'quota failures must remain retryable');
  assert.ok(line.tokenSummary().monthlyQuotaBlockedUntil);
  now += 60001;
  assert.equal((await line.pushMessage('u', [])).sent, true);
  await assert.rejects(line.pushMessage('u', []), /HTTP 500/);
  assert.equal(finishes.length, 4, 'each send is finalized once');
  assert.equal(finishes[3].httpStatus, 500, 'catch must not erase the HTTP status');
});

test('optional canary reports once but never claims verification; required canary still blocks', async () => {
  const mod = { exports: {} }; let info = 0, fetches = 0;
  vm.runInNewContext(service('ragicFreshness'), { module: mod, exports: mod.exports, process: { env: {} }, Date, setTimeout, console: { info() { info++; }, warn() { throw Error('optional protection is not a failed job'); } } });
  const run = mod.exports.runCanaryWriteReadProof;
  const options = { sheetCode: 'H05', config: { sheetCode: 'H05', requireConfigured: false }, fetchSnapshot: async () => { fetches++; return [{ _ragicId: '1' }]; } };
  for (let i = 0; i < 2; i++) assert.equal((await run(options)).freshness.freshness_verified, null);
  assert.equal(info, 1); assert.equal(fetches, 2);
  await assert.rejects(run({ ...options, config: { ...options.config, requireConfigured: true } }));
  assert.equal(fetches, 2);
});

test('H05 invalid snapshots cannot delete shadow or deactivate venues through any caller', async () => {
  const text = service('ragicAdmin');
  const names = ['_shadowPullH05Impl', '_readShadowH05', '_reconcileH05FromShadowImpl', '_mapRagicVenue', 'diffVenuesFromRagic', 'applyVenueSync'];
  if (text.includes('function _validatedVenueMap(')) names.push('_validatedVenueMap');
  const code = names.map(n => { const match = text.match(new RegExp('(?:async )?function ' + n + '\\([\\s\\S]*?\\n\\}')); assert.ok(match, n); return match[0]; }).join('\n');
  for (const records of [[], [{}], [{ 部門編號: 'B' }, {}], [{ 部門編號: 'B' }, { 部門編號: 'B' }]]) {
    let writes = 0;
    const db = { query: async sql => { if (/INSERT|UPDATE|DELETE/.test(sql)) writes++; return { rows: sql.includes('raw_data') ? records.map(raw_data => ({ raw_data })) : [{ id: 'B', is_active: true }], rowCount: 1 }; }, release() {} };
    const ctx = { records, pool: { ...db, connect: async () => db }, ragicEnabled: () => true, _withFreshness: v => v, _ragicLastUpdateValue: () => null, _alertFreshnessIfNeeded: async () => {}, console: { warn() {}, error() {} }, ragic: { getActiveVenuesWithFreshness: async () => ({ records }), isCanaryRecord: () => false }, VENUE_SYNC_FIELDS: [] };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    assert.ok((await ctx._shadowPullH05Impl()).error);
    assert.ok((await ctx._reconcileH05FromShadowImpl()).error);
    await assert.rejects(ctx.diffVenuesFromRagic());
    await assert.rejects(ctx.applyVenueSync({ removed: ['B'] }));
    assert.equal(writes, 0);
  }
});

test('sync error sanitization includes malformed identity numbers', () => {
  const mod = { exports: {} };
  vm.runInNewContext(service('syncFailureLog'), { module: mod, exports: mod.exports, console });
  assert.equal(mod.exports.sanitizeMessage('身分證 A12345678901 格式錯誤'), '身分證 <id> 格式錯誤');
  const code = service('ragicAdmin').match(/function _syncErrorMessage\([\s\S]*?\n\}/)[0];
  const ctx = { syncFailureLog: mod.exports }; vm.createContext(ctx); vm.runInContext(code, ctx);
  assert.ok(!ctx._syncErrorMessage({ code: 'RAGIC_VALIDATION_ERROR', message: 'A12345678901' }).includes('A123'));
});

test('student validation names missing fields and rejects malformed IDs before writing', async () => {
  const code = service('ragic').match(/function validateNewSourceStudent\([\s\S]*?\n\}/)[0] + '\n' + service('ragic').match(/async function syncParentStudentsStrict\([\s\S]*?\n\}/)[0];
  const ctx = { FIELD: { Z01: { PHONE: 'phone', LINE_UID: 'uid' } }, getParentRecordByRagicId: async () => ({ phone: '0900000000' }), parseZ01Students: () => [] };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const input = { parent: { phone: '0900000000' }, ragicRecordId: '1', students: [{ name: 'child', birth_date: '', gender: '男', id_number: 'A123456789' }] };
  await assert.rejects(ctx.syncParentStudentsStrict(input), /請補齊學員：生日$/);
  input.students[0].birth_date = '2010-01-01'; input.students[0].id_number = 'A12345678901';
  await assert.rejects(ctx.syncParentStudentsStrict(input), /身分證字號格式錯誤/);
});

test('canonical family import copies source identity as data, never uses it to transfer or merge', async () => {
  const code = service('ragicAdmin').match(/async function _syncCanonicalZ01Record\([\s\S]*?\n\}/)[0];
  for (const existing of [[], [{ id: 'student', name: 'child', id_number: '' }], [{ id: 'student', name: 'child', id_number: 'B223456780' }]]) {
    const hadExisting = existing.length > 0;
    const writes = []; const parent = { id: 'family', phone: '0900000000', line_uid: 'uid' };
    const child = { name: 'child', birth_date: '2010-01-02', gender: '男', id_number: 'A123456789' };
    const ctx = { ...require('../services/studentAudit'), normalizePhone: x => x, normalizeStudentName: x => x, _trueZ01LineUid: () => 'uid', _venueIdFromMap: () => 'B', _z01SyncError: (c,m) => Error(m), ragic: { normalizeGender: x => x, parseZ01StudentsRaw: () => [], parseZ01Students: () => [child] } };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    const client = { query: async (sql, args) => {
      if (/FROM parents|UPDATE parents/.test(sql)) return { rows: [parent] };
      if (/SELECT \* FROM students/.test(sql)) { assert.equal(args[0], 'family'); assert.ok(!sql.includes('id_number')); return { rows: existing }; }
      if (/UPDATE students|INSERT INTO students/.test(sql)) { writes.push({ sql, args }); return { rows: [{ id: 'student' }] }; }
      return { rows: [] };
    } };
    await ctx._syncCanonicalZ01Record(client, { _ragicId: '1' }, { phone: parent.phone }, new Map());
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args[6], child.id_number, 'source ID must reach the local mirror');
    if (hadExisting) assert.match(writes[0].sql, /id_number = COALESCE\(NULLIF\(id_number,''\), NULLIF\(\$7,''\)\)/, 'existing identities remain unchanged');
    else assert.ok(writes[0].sql.includes('id_number'));
  }
});
