const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../server/node_modules/pg');
const { run } = require('../scripts/tutor-consistency-repair');

(async () => {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.match(url.pathname, /audit|test/);
  const pool = new Pool({ connectionString: url.toString() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-repair-test-'));
  const parentId = randomUUID(), studentId = randomUUID(), periodId = randomUUID(), sessionId = randomUUID(), enrollmentId = 'repair-' + randomUUID();
  const file = name => path.join(dir, name + '.json');
  try {
    const coach = (await pool.query('SELECT id,name FROM coaches ORDER BY id LIMIT 1')).rows[0];
    const venue = (await pool.query('SELECT id FROM venues ORDER BY id LIMIT 1')).rows[0];
    assert.ok(coach && venue, 'bootstrap fixture required');
    await pool.query('INSERT INTO parents(id,name,phone) VALUES($1,$2,$3)', [parentId, 'repair test', 'test-' + parentId.slice(0, 10)]);
    await pool.query('INSERT INTO students(id,parent_id,name) VALUES($1,$2,$3)', [studentId, parentId, 'repair student']);
    await pool.query(`INSERT INTO admin_enrollments(id,parent_name,parent_phone,students,coach,coach_id,venue_id,course_type,original_price,final_price,status,submitted_at)
      VALUES($1,'test','test',ARRAY['test'],'[object Object]',$2,$3,1,1200,1200,'refunded',now())`, [enrollmentId, coach.id, venue.id]);
    await pool.query(`INSERT INTO course_periods(id,coach_id,venue_id,course_type,total_sessions,used_sessions,expires_at,original_price,final_price,status,admin_enrollment_id)
      VALUES($1,$2,$3,1,6,1,current_date+30,1200,1200,'refunded',$4)`, [periodId, coach.id, venue.id, enrollmentId]);
    await pool.query("INSERT INTO course_sessions(id,course_period_id,scheduled_at,status,session_deducted) VALUES($1,$2,now()-interval '2 days','confirmed',true)", [sessionId, periodId]);
    await pool.query('INSERT INTO checkin_records(course_session_id,student_id) VALUES($1,$2)', [sessionId, studentId]);
    const options = { url: url.toString(), confirmDatabase: url.pathname.slice(1), actor: 'isolated-test' };
    const dry = await run({ ...options, output: file('plan') });
    assert.equal(dry.proposed, 3);
    assert.equal((await pool.query('SELECT entitlement_state FROM course_periods WHERE id=$1', [periodId])).rows[0].entitlement_state, 'ACTIVE');
    await assert.rejects(run({ ...options, mode: 'apply', planFile: file('plan'), confirmDatabase: 'wrong', backupFile: file('no'), receiptFile: file('no-receipt') }), /confirmation/);
    await run({ ...options, mode: 'apply', planFile: file('plan'), backupFile: file('backup'), receiptFile: file('receipt') });
    assert.equal(JSON.parse(fs.readFileSync(file('receipt'))).committed, true);
    const changed = await pool.query('SELECT status,entitlement_state,used_sessions FROM course_periods WHERE id=$1', [periodId]);
    assert.equal(changed.rows[0].entitlement_state, 'MANUAL_REVIEW'); assert.equal(changed.rows[0].used_sessions, 1);
    assert.equal((await pool.query('SELECT status FROM course_sessions WHERE id=$1', [sessionId])).rows[0].status, 'completed');
    await assert.rejects(run({ ...options, mode: 'apply', planFile: file('plan'), backupFile: file('replay'), receiptFile: file('replay-receipt') }), /stale/);
    await run({ ...options, mode: 'rollback', planFile: file('backup'), backupFile: file('rollback-backup'), receiptFile: file('rollback-receipt') });
    for (const row of JSON.parse(fs.readFileSync(file('plan'))).changes) {
      const current = (await pool.query(`SELECT to_jsonb(t) row FROM ${row.table} t WHERE id=$1`, [row.id])).rows[0].row;
      assert.deepEqual(current, row.before, 'rollback restores exact prior row');
    }
    await pool.query('UPDATE course_periods SET updated_at=now() WHERE id=$1', [periodId]);
    await assert.rejects(run({ ...options, mode: 'apply', planFile: file('plan'), backupFile: file('stale'), receiptFile: file('stale-receipt') }), /stale/);
    console.log('PASS: repair read-only plan, explicit target, backup, apply, replay refusal, exact rollback, concurrent edit refusal; used_sessions unchanged');
  } finally {
    await pool.query('DELETE FROM checkin_records WHERE course_session_id=$1', [sessionId]);
    await pool.query('DELETE FROM course_sessions WHERE id=$1', [sessionId]);
    await pool.query('DELETE FROM course_periods WHERE id=$1', [periodId]);
    await pool.query('DELETE FROM admin_enrollments WHERE id=$1', [enrollmentId]);
    await pool.query('DELETE FROM students WHERE id=$1', [studentId]);
    await pool.query('DELETE FROM parents WHERE id=$1', [parentId]);
    await pool.end();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('tutor-repair-test-'));
    fs.rmSync(dir, { recursive: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
