'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const audit = require('../services/studentAudit');

test('student diff preserves identifiers and includes activation and calendar-date changes', () => {
  assert.deepEqual(audit.diffChanges({ is_active: true, student_code: '001', birth_date: new Date(2010, 0, 2) },
    { is_active: false, student_code: '1', birth_date: '2010-01-02' }), {
    student_code: { before: '001', after: '1' }, is_active: { before: true, after: false },
  });
  assert.equal(audit.diffChanges({ birth_date: new Date(2010, 0, 2) }, { birth_date: '2010-01-02' }), null);
});

test('create audit records persisted defaults, stable actor, and propagates failures', async () => {
  const calls = [];
  const db = { async query(sql, args) {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT')) return { rows: [{ id: 's', name: 'child', is_active: true, parent_id: 'p' }] };
    return { rows: [] };
  } };
  await audit.writeStudentAudit(db, 's', 'create', audit.parentActor('p', 'registration'));
  const row = calls[1].args;
  assert.equal(row[2], 'parent:p');
  assert.equal(row[3], 'parent');
  assert.deepEqual(JSON.parse(row[4]).is_active, { before: null, after: true });
  assert.ok(!calls[1].sql.includes('created_at'), 'never backdate historical evidence');
  await assert.rejects(audit.writeStudentAudit(db, 's', 'create'), /ACTOR_REQUIRED/);
  await assert.rejects(audit.writeStudentAudit({ query: async () => { throw Error('audit unavailable'); } },
    's', 'edit', { ...audit.parentActor('p'), changes: { name: { before: 'a', after: 'b' } } }), /audit unavailable/);
});

test('unchanged edit creates no misleading audit event', async () => {
  await audit.writeStudentAudit({ query() { throw Error('unexpected write'); } }, 's', 'edit', audit.parentActor('p'));
  assert.equal(audit.adminActorName({ adminUser: { sub: 'stable-id', name: 'editable-name' } }), 'stable-id');
});

function loadAdminPatch(db, schedule) {
  let handler;
  const router = { get() {}, patch(_path, ...args) { handler = args.at(-1); } };
  const shared = require('../routes/admin/_customerShared');
  const context = { module: { exports: {} }, console: { error() {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name.endsWith('/models/db')) return { pool: { connect: async () => db } };
    if (name.endsWith('/dateTime')) return { formatPlainDate: x => x };
    if (name.endsWith('/paging')) return {};
    if (name.endsWith('/adminAuth')) return { requireAdminAuth() {}, isVenueInScope: () => true };
    if (name.endsWith('/requireResource')) return { requireResource: () => () => {} };
    if (name === './_customerShared') return shared;
    if (name.endsWith('/ragicWriteback')) return { scheduleWriteback: schedule };
    throw Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/admin/customerStudents.js'), 'utf8'), context);
  return handler;
}

for (const auditFails of [false, true]) {
  test(`admin activation update ${auditFails ? 'rolls back on audit failure' : 'commits audit before scheduling writeback'}`, async () => {
    const events = [];
    let committed = false;
    let released = false;
    const row = { id: 's', name: 'child', is_active: true, parent_line_uid: 'real-uid', v: 'B' };
    const db = { async query(sql, args) {
      events.push(sql);
      if (sql.includes('SELECT p.primary_venue_id')) {
        assert.match(sql, /FOR UPDATE OF s/);
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE students')) return { rows: [{ ...row, is_active: false }], rowCount: 1 };
      if (sql.includes('INSERT INTO student_audit_logs')) {
        assert.equal(args[2], 'staff-123');
        assert.equal(args[3], 'manager');
        assert.deepEqual(JSON.parse(args[4]), { is_active: { before: true, after: false } });
        if (auditFails) throw Error('audit disk failure');
      }
      if (sql === 'COMMIT') committed = true;
      return { rows: [], rowCount: 0 };
    }, release() { released = true; } };
    const handler = loadAdminPatch(db, () => { assert.equal(committed, true); events.push('schedule'); });
    let status = 200;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    await handler({ params: { id: 's' }, body: { is_active: false }, query: {}, adminUser: { sub: 'staff-123', role: 'manager' } }, res);
    assert.equal(status, auditFails ? 500 : 200);
    assert.equal(committed, !auditFails);
    assert.equal(events.includes('ROLLBACK'), auditFails);
    assert.equal(events.includes('schedule'), !auditFails);
    assert.equal(released, true);
  });
}

for (const [environment, demoEnabled, expectedCreates, failAudit] of [
  ['production', false, 0, false], ['production', true, 1, false],
  ['development', false, 2, false], ['development', false, 1, true],
]) {
  test(`demo seed guard and atomic audit: ${environment}, demo=${demoEnabled}, failure=${failAudit}`, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../bootstrap/coreSchema.js'), 'utf8');
    const code = source.match(/async function seedVenuesCoachesParents\([\s\S]*?\n\}/)[0];
    const events = [];
    let inserted = 0;
    let released = 0;
    const client = { async query(sql, args) {
      events.push(sql);
      if (sql.includes('INSERT INTO students')) { inserted++; return { rows: [{ id: 's' }] }; }
      if (sql.includes('SELECT * FROM students')) return { rows: [{ id: 's', name: 'demo child' }] };
      if (sql.includes('INSERT INTO student_audit_logs')) {
        assert.equal(args[2], 'system:demo-seed');
        if (failAudit) throw Error('audit unavailable');
      }
      return { rows: [] };
    }, release() { released++; } };
    const ctx = { VENUES: [], COACHES: [], PARENTS: [
      { phone: 'demo', demoLogin: true, students: [{ name: 'demo child' }] },
      { phone: 'development', students: [{ name: 'development child' }] },
    ], pool: { connect: async () => client, async query(sql) {
      assert.ok(!sql.includes('INSERT INTO students'), 'student writes must use transaction client');
      return { rows: sql.includes('SELECT id FROM parents') ? [{ id: 'parent' }] : [] };
    } }, process: { env: { NODE_ENV: environment, ALLOW_DEMO_LOGIN: demoEnabled ? '1' : '0' } },
    require(name) { assert.equal(name, '../services/studentAudit'); return audit; }, console };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    if (failAudit) await assert.rejects(ctx.seedVenuesCoachesParents(), /audit unavailable/);
    else await ctx.seedVenuesCoachesParents();
    assert.equal(inserted, expectedCreates);
    assert.equal(released, expectedCreates);
    assert.equal(events.filter(sql => sql === 'COMMIT').length, failAudit ? 0 : expectedCreates);
    assert.equal(events.includes('ROLLBACK'), failAudit);
  });
}
