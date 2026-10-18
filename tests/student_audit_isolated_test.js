'use strict';
// Explicit isolated PostgreSQL only; creates and drops a task-owned schema.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Client } = require('../server/node_modules/pg');
const audit = require('../server/services/studentAudit');

function extract(file, name) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

async function main() {
  const url = new URL(process.env.DATABASE_URL || 'http://missing');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'DATABASE_URL must point to an isolated loopback PostgreSQL');
  assert.equal(process.env.STUDENT_AUDIT_ISOLATED, '1', 'Set STUDENT_AUDIT_ISOLATED=1 only for the disposable test cluster');
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  const schema = `audit_test_${crypto.randomBytes(6).toString('hex')}`;
  let created = false;
  let assertions = 0;
  try {
    await db.query(`CREATE SCHEMA ${schema}`); created = true;
    await db.query(`SET search_path TO ${schema}, public`);
    await db.query(`CREATE TABLE parents (id uuid PRIMARY KEY, ragic_record_id text, updated_at timestamptz DEFAULT now());
      CREATE TABLE students (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_id uuid REFERENCES parents(id), name text NOT NULL,
        birth_date date, gender text, id_number text, blood_type text, student_code text, ragic_record_id text,
        is_active boolean DEFAULT true, last_synced_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE student_audit_logs (
        id bigserial PRIMARY KEY, student_id uuid REFERENCES students(id), at timestamptz DEFAULT now(),
        action text, by_user text, by_role text, changes jsonb, note text);`);
    const parentId = crypto.randomUUID();
    await db.query('INSERT INTO parents(id) VALUES ($1)', [parentId]);
    const context = { ...audit, studentAuditParentActor: audit.parentActor, pool: { connect: async () => ({ query: db.query.bind(db), release() {} }) },
      normalizeStudentName: value => String(value || '').trim(), Z03ClaimError: Error,
      ragic: { normalizeGender: value => value }, console: { warn() {} }, BindConflictError: Error };
    vm.createContext(context);
    for (const [file, name] of [
      ['server/routes/parents.js', 'persistStudentMirrorAfterRagic'],
      ['server/routes/groupOrders.js', 'resolveBoundStudents'],
      ['server/services/z03IdentityClaim.js', '_safeDate'],
      ['server/services/z03IdentityClaim.js', '_insertOrReuseStudent'],
      ['server/services/parentSync.js', 'upsertLocalStudents'],
    ]) vm.runInContext(extract(file, name), context);

    // The actual parent mirror entrypoint owns its transaction and rollback.
    const student = { name: 'isolated child', id_number: 'ISOLATED-ID', birth_date: '2010-01-02', gender: '男' };
    const id = await context.persistStudentMirrorAfterRagic({ parentId, student });
    let logs = (await db.query('SELECT * FROM student_audit_logs ORDER BY id')).rows;
    assert.equal(logs.length, 1); assertions++;
    assert.equal(logs[0].action, 'create'); assertions++;
    assert.equal(logs[0].by_user, `parent:${parentId}`); assertions++;
    assert.deepEqual(logs[0].changes.name, { before: null, after: student.name }); assertions++;
    assert.ok(logs[0].at instanceof Date); assertions++;
    // Retried refresh is not another creation or a fake edit event.
    await context.persistStudentMirrorAfterRagic({ parentId, studentId: id, student });
    assert.equal(Number((await db.query('SELECT count(*) FROM student_audit_logs')).rows[0].count), 1); assertions++;
    await context.persistStudentMirrorAfterRagic({ parentId, studentId: id, student: { ...student, name: 'edited child' } });
    logs = (await db.query('SELECT * FROM student_audit_logs ORDER BY id')).rows;
    assert.deepEqual(logs[1].changes.name, { before: student.name, after: 'edited child' }); assertions++;

    // A real SQL audit failure must roll back both a create and an edit.
    await db.query("ALTER TABLE student_audit_logs ADD CONSTRAINT reject_audit CHECK (note <> 'parent-student-mirror') NOT VALID");
    await assert.rejects(context.persistStudentMirrorAfterRagic({ parentId, student: { ...student, id_number: 'FAIL-CREATE', name: 'must rollback' } }), { code: '23514' }); assertions++;
    assert.equal((await db.query("SELECT id FROM students WHERE id_number = 'FAIL-CREATE'")).rowCount, 0); assertions++;
    await assert.rejects(context.persistStudentMirrorAfterRagic({ parentId, studentId: id, student: { ...student, name: 'must rollback edit' } }), { code: '23514' }); assertions++;
    assert.equal((await db.query('SELECT name FROM students WHERE id=$1', [id])).rows[0].name, 'edited child'); assertions++;
    assert.equal(Number((await db.query('SELECT count(*) FROM student_audit_logs')).rows[0].count), 2); assertions++;
    await db.query('ALTER TABLE student_audit_logs DROP CONSTRAINT reject_audit');

    // Group and registration helpers participate in the outer transaction.
    await db.query('BEGIN');
    const group = await context.resolveBoundStudents(db, parentId, [], [{ name: 'group child', birth_date: '2011-01-01' }]);
    const first = await context._insertOrReuseStudent(db, parentId, { name: 'registration child' });
    const replay = await context._insertOrReuseStudent(db, parentId, { name: 'registration child' });
    assert.equal(replay.student.id, first.student.id); assertions++;
    assert.equal(replay.appended, false); assertions++;
    assert.equal((await db.query("SELECT id FROM student_audit_logs WHERE student_id IN ($1,$2)", [group.ids[0], first.student.id])).rowCount, 2); assertions++;
    await db.query('ROLLBACK');
    assert.equal((await db.query("SELECT id FROM students WHERE id IN ($1,$2)", [group.ids[0], first.student.id])).rowCount, 0); assertions++;
    assert.equal((await db.query("SELECT id FROM student_audit_logs WHERE student_id IN ($1,$2)", [group.ids[0], first.student.id])).rowCount, 0); assertions++;

    const otherParent = crypto.randomUUID();
    await db.query('INSERT INTO parents(id) VALUES ($1)', [otherParent]);
    const linked = (await db.query("INSERT INTO students(parent_id,name,ragic_record_id) VALUES ($1,'link owner','old-link') RETURNING id", [otherParent])).rows[0];
    await db.query('BEGIN');
    await context.upsertLocalStudents(db, parentId, [{ name: 'synced child', ragic_record_id: 'old-link' }]);
    const releasedLinkAudit = (await db.query('SELECT * FROM student_audit_logs WHERE student_id=$1', [linked.id])).rows;
    assert.equal(releasedLinkAudit.length, 1); assertions++;
    assert.equal(releasedLinkAudit[0].by_user, 'ragic:parent-sync'); assertions++;
    assert.deepEqual(releasedLinkAudit[0].changes.ragic_record_id, { before: 'old-link', after: null }); assertions++;
    assert.equal((await db.query('SELECT ragic_record_id FROM students WHERE id=$1', [linked.id])).rows[0].ragic_record_id, null); assertions++;
    await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT ragic_record_id FROM students WHERE id=$1', [linked.id])).rows[0].ragic_record_id, 'old-link'); assertions++;
    assert.equal((await db.query('SELECT id FROM student_audit_logs WHERE student_id=$1', [linked.id])).rowCount, 0); assertions++;

    const mirrorId = await context.persistStudentMirrorAfterRagic({ parentId, student: { ...student, id_number: 'LINK-MIRROR' }, sync: { z02: { ragicRecordId: 'old-link' } } });
    const mirrorLinkAudit = (await db.query('SELECT * FROM student_audit_logs WHERE student_id=$1', [linked.id])).rows[0];
    assert.equal(mirrorLinkAudit.by_role, 'system'); assertions++;
    assert.deepEqual(mirrorLinkAudit.changes.ragic_record_id, { before: 'old-link', after: null }); assertions++;
    assert.equal((await db.query('SELECT ragic_record_id FROM students WHERE id=$1', [mirrorId])).rows[0].ragic_record_id, 'old-link'); assertions++;
    console.log(JSON.stringify({ test: 'student_audit_isolated', status: 'PASS', assertions, productionWrites: 0 }));
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    if (created) await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
